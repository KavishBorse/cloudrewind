# CloudRewind

CloudRewind collects timestamped system readings and lets an engineer rewind to a time, compare readings, and inspect incident evidence. The current build includes account workspaces with role-based invites, an opt-in isolated sample data stream, a separate agent for real machine metrics, an AWS CloudWatch reader for one EC2 instance per project, event markers, rule-based incident detection, optional Groq incident analysis, bookmarks, and incident report downloads.

## Run locally

Requirements: Node.js 20.19+ or 22.12+ for the current Vite frontend. The standalone agent itself supports Node.js 18+.

1. Copy `backend/.env.example` to `backend/.env` and set a private `JWT_SECRET`.
2. In `backend/`, run `npm install` and `npm run dev`.
3. In `frontend/`, run `npm install` and `npm run dev`.
4. Open the Vite address printed in the terminal and create an account with your name, email, and password. Organization/team is optional and becomes the default workspace name. Email OTP is not enabled in this build, so signup completes immediately. Your workspace starts empty so real telemetry is not confused with sample data. From Projects, you can explicitly create one isolated sample project for trying the investigation workflow.

Each account starts as the owner of a workspace. From **Team**, an owner can create an invite link for an email address and share it with a teammate; no email is sent by the current build. Links expire after seven days and can be accepted by an account whose entered email matches. Since OTP verification is not enabled yet, this does not prove control of that email address. Members can view workspace projects and incident data. Admins can manage projects and invite members; only the owner can grant admin access. Use the workspace selector in the header to switch between your workspace and teams you have joined.

The frontend uses `VITE_API_URL` for its backend address. Its default is `http://localhost:5000`. Add `frontend/.env` from `frontend/.env.example` when using another address. The backend accepts browser requests from localhost Vite ports 5173 and 5174 by default; set `CORS_ORIGINS` in `backend/.env` to a comma-separated list of the frontend origins you use.

To run against a separate local database, set `CLOUDREWIND_DB_PATH` in the backend environment. When unset, CloudRewind uses `backend/cloudrewind.db`.

### PostgreSQL development and storage migration

SQLite remains the default for a quick local run. To exercise the hosted-storage path locally, start the development PostgreSQL service from the repository root:

```sh
docker compose -f docker-compose.postgres.yml up -d
```

Set `DATABASE_URL=postgresql://cloudrewind:cloudrewind-local-only@localhost:5432/cloudrewind` in `backend/.env`, then restart the backend. The backend applies versioned PostgreSQL schema migrations before listening. `GET /ready` checks database connectivity; `GET /health` remains a process liveness check. The Compose password is for local development only; use a secret manager and a managed PostgreSQL service for any hosted environment.

To copy an existing local SQLite database, first run the backend once with `DATABASE_URL` blank so startup can apply the local schema/workspace migrations, then stop it. Start PostgreSQL and set `DATABASE_URL`, `JWT_SECRET`, and `CLOUDREWIND_DB_PATH` in `backend/.env`. Then, from `backend/`, run `npm run db:import-sqlite -- "C:/path/to/cloudrewind.db"` (or omit the path to use `CLOUDREWIND_DB_PATH`). The importer refuses a non-empty PostgreSQL application database, checks that the SQLite workspace backfill completed, copies tables in foreign-key order, resets generated ID sequences, and verifies row counts inside one transaction. Take a separate backup before migration; the importer does not modify the SQLite source.

For operational backups, use PostgreSQL's native tools and store encrypted backup files outside the database host. For example, `pg_dump --format=custom --file=cloudrewind.dump "$DATABASE_URL"` creates a restorable custom-format dump, and `pg_restore --clean --if-exists --dbname="$DATABASE_URL" cloudrewind.dump` restores it. A hosted deployment should schedule and retain managed snapshots or dumps, test restores, alert on failed backups, and monitor `/ready`; none of those hosted operations are provisioned by this repository yet.

## Explore a demo incident

From Projects, choose **Create sample project** to add one explicit, isolated demo stream to your workspace. It is labeled as simulated and does not connect to AWS or your real agent projects. The dashboard has repeatable CPU spike, memory leak, database flood, container loss, and bad deploy scenarios. Readings arrive every five seconds. The incident detector groups abnormal readings, associates a nearby deploy event when present, and records an evidence sequence. Each sequence shows measurements and detection rules; it describes time order and does not claim to prove causation.

The controlled scenario bench records each run's expected signal, detector version, whether the detector found it, detection delay, and unexpected flags during normal-control runs. Positive-run detection rate is matching signals divided by completed injected faults. The normal-control false-alarm rate is runs with any flag divided by completed no-fault controls. Delay is the first matching flag timestamp minus the scenario start. Results describe this simulator only; they are not estimates of production performance. Runs are serialized to keep labels attributable. Export the recorded runs as CSV for analysis.

Use the timeline to rewind, or select two moments and compare them. The incident view links evidence back to the timeline. Bookmarks can preserve noteworthy moments, and each incident can be downloaded as a Markdown report.

## Connect a real machine and application

Create a non-demo CloudRewind project for one application environment (production, staging, development, or other) and copy its API key when it is shown. This does not import your source code. Put the agent on the machine that runs the service, set `CLOUDREWIND_KEY` in the agent's environment, then run this from the repository root:

```sh
node agent/index.js --url=http://localhost:5000 --service=api
```

The agent sends CPU and memory use for the machine it runs on, plus network throughput on Linux. Each agent reports a service name and a host instance name (the machine hostname by default), so replicas of the same service keep separate timelines. Override the instance with `--instance` when needed. To monitor whether the application endpoint responds, add `--health-url=https://your-app.example/health`. The agent makes a GET request from that machine and sends only the HTTP status code and response time to headers. It never sends the URL or response body. Three consecutive failed checks open a critical incident; three consecutive response-time deviations above the recent baseline open a warning. The agent keeps a bounded in-memory buffer during brief connection failures and requires no cloud-account credentials.

For Docker Compose workloads on that host, set `--docker-project=<compose-project>` to count only that project's running containers. For database health and connection count, add an app-owned JSON endpoint and set `--metrics-url=http://127.0.0.1:<port>/<path>`; the agent does not discover or log in to databases directly. The endpoint returns `{"db_connected":true,"db_connections":4}` or `{"db_connected":false}` when the app cannot connect. Protect it with a shared token in `CLOUDREWIND_METRICS_TOKEN` and do not expose it publicly. See [agent setup](agent/README.md) for the response contract and permissions.

Use a hidden prompt or a service/container secret store for `CLOUDREWIND_KEY`; do not put the key in command arguments. For a real project, the dashboard can also read EC2 metrics from CloudWatch and compare its 5-minute CPU buckets with the explicitly mapped agent stream for that EC2 host. AWS data is stored separately and labeled as CloudWatch so AWS CPU and agent CPU are never silently combined. Incident detail and downloadable reports include any CloudWatch readings synced near the incident, plus a same-period comparison against that mapped agent stream. CloudWatch's default EC2 metrics do not include guest memory or app health; those remain the agent's job. CloudRewind does not collect source code, logs, or request traces. Local simulated scenarios are for testing the detector and are not production telemetry.

## Connect AWS CloudWatch (EC2)

On a real project's dashboard, save the EC2 instance ID and AWS region, then choose **Sync CloudWatch**. The first integration reads `CPUUtilization`, `NetworkIn`, `NetworkOut`, and `StatusCheckFailed` using 5-minute periods. It only calls the read operation `GetMetricStatistics`, stores the returned samples in the CloudRewind database, and limits syncs to one per minute. It does not create AWS resources or change instance monitoring settings.

The backend must have an AWS identity. For a same-account or self-hosted setup, use a named AWS profile (prefer an IAM Identity Center or other temporary-credential profile) and put `AWS_PROFILE=<profile-name>` in `backend/.env`, then restart the backend. The optional IAM role ARN field enables cross-account access: CloudRewind generates and stores a unique External ID for the project, then the backend identity calls STS `AssumeRole` for 15-minute credentials during each sync. The customer role's trust policy must allow the identity running the backend and require the displayed External ID. Grant that role only `cloudwatch:GetMetricStatistics`. AWS does not offer resource-level scoping for this action, so that permission must use `Resource: "*"` and can read metric statistics across the connected AWS account; CloudRewind itself requests only the configured EC2 instance's metrics. The backend identity also needs `sts:AssumeRole` permission for that role. Never paste AWS access keys into the browser, project settings, source code, or CloudRewind's database. This is an implementation path for cross-account access; a production hosted service still needs a deployed identity and customer onboarding instructions tailored to that deployment.

EC2 basic monitoring publishes most instance metrics in 5-minute periods and does not charge for basic monitoring; enabling detailed 1-minute monitoring can add charges. CloudWatch API usage and any CloudRewind hosting costs are separate, and free-tier eligibility depends on the AWS account and usage. The integration deliberately syncs on demand instead of continuously polling. Check AWS billing before increasing its frequency. See [EC2 basic and detailed monitoring](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/manage-detailed-monitoring.html), [EC2 CloudWatch metrics](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/viewing_metrics_with_cloudwatch.html), and [CloudWatch API billing guidance](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch_billing.html).

For a Linux host, `agent/cloudrewind-agent.service.example` is a systemd template. Install the agent files under `/opt/cloudrewind-agent`, create a dedicated unprivileged `cloudrewind-agent` account, copy `agent/cloudrewind-agent.env.example` to `/etc/cloudrewind-agent.env`, replace the key and optional health URL, and restrict that environment file to root (`chmod 600`). Update the CloudRewind HTTPS URL and service name in the unit file, install it under `/etc/systemd/system/`, then run `systemctl daemon-reload` and `systemctl enable --now cloudrewind-agent`.

For local Docker demonstrations, `docker-compose.demo.yml` starts a small load-generating app and the agent; set `CLOUDREWIND_KEY` in a root `.env` first.

## Incident detection

- CPU or memory at 90% or higher creates a critical signal.
- Database connections at 85% of the project's configured maximum create a signal.
- A metric that remains more than three standard deviations above its recent baseline for three readings creates a signal.
- A decrease in running container count creates a signal.
- Three consecutive failed HTTP health checks create a critical signal; response-time deviations use the same explainable baseline rule.
- Signals are grouped into a project incident and close after two minutes without another signal.
- A deploy in the 15 minutes before the first signal is linked as nearby context.

The detector is intentionally explainable and small. These heuristics are not a causal model and should be evaluated against repeatable scenarios before making accuracy claims.

## AI incident analysis (optional)

To enable AI summaries and possible-contributor analysis, create a Groq API key and set `GROQ_API_KEY` in `backend/.env`; the default model is `openai/gpt-oss-20b`, which can be changed with `GROQ_MODEL`. Keep the key on the backend and restart it after changing the environment. CloudRewind applies a per-user request limit, and Groq usage is subject to the account's current model limits and terms.

In an incident, choose **Summary** or **Possible causes**, then select a lookback duration from 15 minutes to 7 days (presets or custom). The window ends at the incident's last flagged reading. After the user confirms, CloudRewind sends only the selected window's metric readings, timestamps, anonymized agent service/instance labels, aggregation details, CloudWatch metric names/values/units/statistics/region, and incident severity/trigger metric to Groq. It excludes project/account/resource IDs, email, source code, logs, and deployment descriptions. The model returns possible contributors as hypotheses tied to specific metric readings; it cannot establish causation. Review Groq's [data handling](https://console.groq.com/docs/your-data) and [rate limits](https://console.groq.com/docs/rate-limits) before enabling this for customer data.

## Data retention

Raw readings are kept for 48 hours, then summarized into one-minute rollups through 14 days and 12-hour rollups after that. The backend preserves raw readings in a ten-minute window around saved incidents and bookmarks. Retention runs daily at 03:00 server time; run `node run-retention.js` from `backend/` to invoke it manually.

PostgreSQL uses the same retention policy in a transaction. PostgreSQL autovacuum handles table space reuse; the SQLite-only manual `VACUUM` step is not run for PostgreSQL.

## API overview

- `POST /projects/demo` — opt in to one isolated, simulated sample project for workflow exploration.
- `GET /workspaces` — list the signed-in user's workspaces and roles.
- `GET /workspaces/members` and `GET/POST /workspaces/invitations` — view members and create email-matched invite links for the active workspace.
- `POST /workspaces/invitations/:token/accept` — accept an invite after signing in with its matching account email.
- `POST /ingest` — add a validated reading using `x-api-key`.
- `POST /events` — add a deploy, configuration change, or restart event.
- `GET /projects/:id/snapshots` and `GET /projects/:id/snapshot` — query a service/instance history.
- `GET /projects/:id/diff?from=...&to=...&service=...` — compare two moments.
- `GET /projects/:id/incidents` and `GET /projects/:id/incidents/:incidentId` — inspect incidents and evidence.
- `POST /projects/:id/incidents/:incidentId/narrative` — generate a user-confirmed Groq summary or possible-cause analysis for a selected lookback window.
- `GET /projects/:id/experiments` — review controlled demo scenario detection outcomes and delays.
- `GET /projects/:id/services-at?time=...` — get the nearest reading for each service at one time.
- `GET/PUT/DELETE /projects/:id/aws/connection` — configure or remove one EC2 target for a project.
- `POST /projects/:id/aws/sync` — manually import up to six hours of EC2 CloudWatch metrics (one sync per minute).
- `GET /projects/:id/aws/metrics?from=...&to=...` — read the separately labeled CloudWatch samples saved locally.
- `GET/POST/DELETE /projects/:id/bookmarks` — manage saved moments.
- `GET /projects/:id/report?incident=...` — download a Markdown incident report.

Project routes require a JWT and verify project ownership. Ingest and event creation use the project API key.
