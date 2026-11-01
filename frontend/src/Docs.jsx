function Code({ children }) {
  return (
    <pre className="rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-sm overflow-x-auto my-3">
      {children}
    </pre>
  );
}

function Step({ number, title, children }) {
  return (
    <div className="rounded-xl bg-slate-800/50 border border-slate-700 p-5 mb-4">
      <h2 className="text-lg font-semibold mb-2">
        <span className="text-cyan-300 mr-2">{number}.</span>
        {title}
      </h2>
      <div className="text-slate-300 text-sm space-y-2">{children}</div>
    </div>
  );
}

// Code samples are plain strings built from lines, so characters like $ and { stay exactly as written
const CURL_EVENT = [
  "curl -X POST https://your-backend/events \\",
  "  -H \"x-api-key: $CLOUDREWIND_KEY\" \\",
  "  -H \"Content-Type: application/json\" \\",
  "  -d '{\"event_type\":\"deploy\",\"description\":\"v2.3 released\",\"meta\":{\"version\":\"v2.3\"}}'",
].join("\n");

const POWERSHELL_EVENT = [
  "Invoke-RestMethod -Method Post -Uri https://your-backend/events `",
  "  -Headers @{ \"x-api-key\" = $env:CLOUDREWIND_KEY } -ContentType \"application/json\" `",
  "  -Body '{\"event_type\":\"deploy\",\"description\":\"v2.3 released\"}'",
].join("\n");

const GITHUB_ACTIONS_STEP = [
  "- name: Tell CloudRewind about this deploy",
  "  run: |",
  "    payload=$(jq -n --arg d \"Deploy ${GITHUB_SHA::7}\" --arg c \"$GITHUB_SHA\" \\",
  "      '{event_type:\"deploy\", description:$d, meta:{commit:$c}}')",
  "    curl -fsS -X POST \"$CLOUDREWIND_URL/events\" \\",
  "      -H \"x-api-key: $CLOUDREWIND_KEY\" \\",
  "      -H \"Content-Type: application/json\" \\",
  "      -d \"$payload\"",
  "  env:",
  "    CLOUDREWIND_URL: ${{ secrets.CLOUDREWIND_URL }}",
  "    CLOUDREWIND_KEY: ${{ secrets.CLOUDREWIND_KEY }}",
].join("\n");

export default function Docs() {
  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-1">Connect your project in 3 steps</h1>
      <p className="text-slate-400 text-sm mb-6">
        CloudRewind records your system every few seconds so you can rewind to the moment something went wrong.
      </p>

      <Step number="1" title="Create your account">
        <p>
          Enter your name, email and password. Organization or team is optional. Email verification is not enabled in this build,
          so signup completes immediately; OTP can be added later. Your account starts as the owner of an empty workspace, ready for a real project.
        </p>
      </Step>

      <h2 className="text-lg font-semibold mt-8 mb-2">Work with a team</h2>
      <p className="text-slate-300 text-sm">
        Open <span className="text-slate-100">Team</span> to rename your workspace, review members, and create an invitation link for a specific email address.
        Copy the link and send it to the teammate yourself; CloudRewind does not send invitation emails in this build. It expires after seven days,
        and the teammate must sign in or create an account with that exact email. Email OTP is not enabled yet, so the platform does not verify address ownership.
        Members can inspect shared projects and incidents. Admins can create
        projects and manage member invitations; only the owner can grant admin access. Use the header selector to switch among workspaces you belong to.
      </p>

      <Step number="2" title="Create a project and copy its key">
        <p>
          Open the Projects page, name the application and choose its environment (production, staging, development or other). A key starting with cr_ appears.
          Copy it now. It is shown only once. If you lose it, use Rotate key to get a new one.
        </p>
      </Step>

      <Step number="3" title="Put the agent on the machine you want to watch">
        <p>
          The agent runs on the server or computer you want to monitor and sends readings to the CloudRewind backend URL.
          In this repository build, use the folder named agent from the CloudRewind source. It needs Node 18 or newer.
          The backend URL must be reachable from that machine; localhost works only when the agent and backend run on the same computer.
          The agent does not upload your application source code.
        </p>
        <p>To see exactly what it would send, without sending anything:</p>
        <Code>node agent/index.js --dry-run</Code>
      </Step>

      <Step number="4" title="Start it with your key">
        <Code>node agent/index.js --url=https://your-backend --service=api</Code>
        <p>
          Set <code>CLOUDREWIND_KEY</code> in the agent's environment first. Avoid putting the key in command arguments.
          Within about 10 seconds the project shows <span className="text-green-300">Agent online</span> and
          host metrics appear on the dashboard. Drag the slider to rewind.
        </p>
        <p>PowerShell hidden prompt:</p>
        <Code>{`$secure = Read-Host "CloudRewind key" -AsSecureString
$env:CLOUDREWIND_KEY = (New-Object System.Net.NetworkCredential("", $secure)).Password`}</Code>
        <p>Linux or macOS:</p>
        <Code>read -s CLOUDREWIND_KEY; export CLOUDREWIND_KEY</Code>
        <p>
          The optional health URL is checked from the agent machine. CloudRewind stores only the HTTP status and response time,
          not the URL or response body. For production, inject the key through your service manager or container secret store.
        </p>
        <p>To include application availability and latency, add a URL for your service's health endpoint:</p>
        <Code>--health-url=https://your-app.example/health</Code>
      </Step>

      <h2 className="text-lg font-semibold mt-8 mb-2">Mark deploys on the timeline (optional)</h2>
      <p className="text-slate-300 text-sm">
        Send an event when you deploy, change a setting or restart something. It shows as a marker under the slider and
        as a dashed line on every chart, so you can see whether a problem started right after it. Click a marker to
        rewind to that moment. This uses the same project key as the agent.
      </p>
      <p className="text-slate-300 text-sm mt-2">Linux and macOS:</p>
      <Code>{CURL_EVENT}</Code>
      <p className="text-slate-300 text-sm">Windows PowerShell:</p>
      <Code>{POWERSHELL_EVENT}</Code>
      <p className="text-slate-300 text-sm">
        GitHub Actions: add the step below after your deploy step. Save your backend address and project key as
        repository secrets named CLOUDREWIND_URL and CLOUDREWIND_KEY.
      </p>
      <Code>{GITHUB_ACTIONS_STEP}</Code>
      <ul className="list-disc pl-5 text-slate-300 text-sm space-y-1">
        <li>event_type is deploy, config_change or restart.</li>
        <li>description (up to 200 characters), timestamp (milliseconds, optional) and meta (up to 10 small values) are optional.</li>
        <li>Up to 20 events per minute per key. Events are never deleted by the retention job.</li>
      </ul>

      <h2 className="text-lg font-semibold mt-8 mb-2">Investigate and save an incident</h2>
      <p className="text-slate-300 text-sm">
        CloudRewind flags high CPU or memory, sustained changes from a recent baseline, database connection pressure,
        and decreases in container count. It groups nearby flags into an incident and links a deploy from the previous
        15 minutes when one exists. The evidence view shows the measurements and the rule that raised each flag.
        Timing is useful context, but it does not prove a deploy caused the incident.
      </p>
      <p className="text-slate-300 text-sm mt-2">
        From the Projects page, you can optionally create a clearly labeled sample project before connecting infrastructure. In that sample project, use the repeatable scenario buttons to create a CPU spike, memory leak, database flood,
        container loss, or bad deploy. The scenario bench records expected-signal detection and delay, plus false
        alarms during normal-control runs. These are controlled simulator results, not production accuracy
        measurements. Each run records the rule version and can be exported as CSV. Rewind to two moments and compare
        them, save a bookmark with a note, or download an incident as a Markdown report.
      </p>

      <h2 className="text-lg font-semibold mt-8 mb-2">Optional: connect AWS CloudWatch</h2>
      <p className="text-slate-300 text-sm">
        This step can wait until you have an EC2 instance. In a real project, enter its AWS region and instance ID on the dashboard,
        then select the agent service and host running on that same EC2 machine. CloudRewind uses that mapping for the five-minute CPU
        comparison and incident context. Leave the optional role ARN blank to use the backend's AWS profile or attached IAM role directly.
        For a customer AWS account, enter a read-only role ARN; the backend assumes it with STS and a generated External ID. The role trust
        policy must allow the identity running the backend and require that External ID, and the role needs CloudWatch read permission.
        Sync is manual; no AWS access keys go in the browser, and this setup creates or changes no AWS resources.
      </p>
      <p className="text-slate-300 text-sm mt-2">
        The host agent works without AWS. For an EC2 host, CloudWatch is an additional provider-level source: enter the EC2 instance ID and region,
        then map it to the agent stream running on that same host. In this repository build, the agent is distributed as source; a published installer
        and hosted HTTPS CloudRewind URL are needed before this is a turnkey public service.
      </p>

      <h2 className="text-lg font-semibold mt-8 mb-2">What the agent sends</h2>
      <p className="text-slate-300 text-sm">Only host readings and, when configured, HTTP status and latency. Anything extra is rejected by the server.</p>
      <Code>{`{ "service": "api", "instance": "host-1", "timestamp": 1760000000000,
  "cpu": 42.1, "memory": 61.3, "network": 530,
  "http_status": 200, "response_ms": 18 }`}</Code>
      <ul className="list-disc pl-5 text-slate-300 text-sm space-y-1">
        <li>cpu: percent of processor time in use</li>
        <li>memory: percent of RAM in use</li>
        <li>network: KB per second, on Linux only</li>
        <li>http_status and response_ms: optional; included only when a health URL is configured. Status 0 means no response.</li>
        <li>instance: the host name by default; each agent's history and alerts stay separate.</li>
      </ul>

      <h2 className="text-lg font-semibold mt-8 mb-2">What it never does</h2>
      <ul className="list-disc pl-5 text-slate-300 text-sm space-y-1">
        <li>It never reads or sends source code, files, environment variables, user data, request contents, the health URL or response body.</li>
        <li>It never opens a port or accepts commands. It only makes outbound requests.</li>
        <li>It needs no special permissions. Run it as a normal user.</li>
        <li>You can read the whole program. It is a single short file.</li>
      </ul>

      <h2 className="text-lg font-semibold mt-8 mb-2">If something goes wrong</h2>
      <ul className="list-disc pl-5 text-slate-300 text-sm space-y-1">
        <li>
          <span className="text-slate-100">Server unreachable:</span> the agent keeps up to 10 minutes of readings in memory
          and sends them when the connection returns.
        </li>
        <li>
          <span className="text-slate-100">Agent offline:</span> a project with no data for 30 seconds shows
          Agent offline. The chart draws the missing time as a gap, never as a made-up line.
        </li>
        <li>
          <span className="text-slate-100">Key rejected:</span> the key was rotated or the project deleted. Create or rotate a key.
        </li>
      </ul>

      <h2 className="text-lg font-semibold mt-8 mb-2">Stop sharing</h2>
      <p className="text-slate-300 text-sm">
        Rotate the key and the old one stops working immediately. Delete the project to remove all of its data.
      </p>
    </div>
  );
}
