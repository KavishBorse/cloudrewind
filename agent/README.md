# CloudRewind agent

A small program that runs next to your application and sends host readings to your CloudRewind project.
It can also check an HTTP health endpoint from that machine. No dependencies. Needs Node 18 or newer.

## Run it

    node index.js --url=https://your-backend --service=api

To monitor an application endpoint as well, add:

    --health-url=https://your-app.example/health

For Docker Compose container counts, pass the Compose project name (shown by `docker compose ls`):

    node index.js --url=https://your-backend --service=api --docker-project=eventease

The agent counts only running containers labelled with that Compose project. The agent's OS account must be allowed
to access Docker. Access to the Docker socket is powerful (effectively administrator access), so grant it only to a
trusted monitoring account.

## Database readings

The agent does not inspect a database or read database credentials. The application owner must expose a small JSON
metrics route on the same host and point the agent to it. For example:

    node index.js --url=https://your-backend --metrics-url=http://127.0.0.1:5000/cloudrewind/metrics

It should return `Content-Type: application/json` with only the fields the app can determine:

    { "db_connected": true, "db_connections": 4 }

`db_connected` is required when reporting this signal. `db_connections` is optional. On database failure, return
`{ "db_connected": false }` with HTTP 200 so the agent can record the outage. Protect this route with a strong shared
token and keep it bound to localhost or otherwise inaccessible to the public. Put that token in
`CLOUDREWIND_METRICS_TOKEN` for the agent and have the app route check the `x-cloudrewind-metrics-token` header.
CloudRewind stores only the boolean and optional count, never credentials or the route response body. Three
consecutive disconnected readings raise a critical incident.

Set `CLOUDREWIND_KEY` in the agent's environment before starting it. For local PowerShell use a hidden prompt:

    $secure = Read-Host "CloudRewind key" -AsSecureString
    $env:CLOUDREWIND_KEY = (New-Object System.Net.NetworkCredential("", $secure)).Password

For Linux or macOS, read it without echoing it:

    read -s CLOUDREWIND_KEY; export CLOUDREWIND_KEY

For production, inject the key through the service manager or container secret store. Avoid putting it in command arguments.

Try it first without sending telemetry:

    node index.js --dry-run

## What it sends

The JSON body contains only the configured readings below. Optional fields are omitted when their source is not configured or cannot be read. The API key is sent separately in the `x-api-key` HTTP header for authentication.

    { "service": "api", "instance": "host-1", "timestamp": 1760000000000, "cpu": 42.1, "memory": 61.3, "network": 530,
      "containers": 2, "db_connected": true, "db_connections": 4, "http_status": 200, "response_ms": 18 }

- cpu: percent of CPU time in use between two readings
- memory: percent of RAM in use
- network: KB/s, Linux only (left out on Windows and macOS)
- http_status and response_ms: included only when `--health-url` is configured; status `0` means no response
- containers: included only when `--docker-project` is configured and Docker can be queried
- db_connected and db_connections: included only when `--metrics-url` returns valid JSON
- instance: host name by default; override with `--instance` to distinguish replicas

## What it never does

- It only reads these environment variables for configuration: `CLOUDREWIND_KEY`, `CLOUDREWIND_INSTANCE`, `CLOUDREWIND_HEALTH_URL`, `CLOUDREWIND_DOCKER_PROJECT`, `CLOUDREWIND_METRICS_URL`, and `CLOUDREWIND_METRICS_TOKEN`. It does not enumerate or transmit environment variables.
- It never reads or sends source code, files, user data, request contents, health URL or response body.
- The optional health check makes a GET request from the agent machine, does not follow redirects, and records only status and time to response headers.
- It never opens a port or accepts commands. It only makes outbound requests.
- Without Docker monitoring, it can run as a normal user. Docker monitoring requires that account to access the Docker socket.

## If the server is down

Readings are kept in memory (up to 120) and sent when the connection returns. Retries slow down
automatically (2s, 4s, ... up to 60s). Press Ctrl+C to stop; it makes one last attempt to send.

## Stop sharing

Rotate the key or delete the project on the CloudRewind Projects page. The old key stops working immediately.
