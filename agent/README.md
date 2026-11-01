# CloudRewind agent

A small program that runs next to your application and sends host readings to your CloudRewind project.
It can also check an HTTP health endpoint from that machine. No dependencies. Needs Node 18 or newer.

## Run it

    node index.js --url=https://your-backend --service=api

To monitor an application endpoint as well, add:

    --health-url=https://your-app.example/health

Set `CLOUDREWIND_KEY` in the agent's environment before starting it. For local PowerShell use a hidden prompt:

    $secure = Read-Host "CloudRewind key" -AsSecureString
    $env:CLOUDREWIND_KEY = (New-Object System.Net.NetworkCredential("", $secure)).Password

For Linux or macOS, read it without echoing it:

    read -s CLOUDREWIND_KEY; export CLOUDREWIND_KEY

For production, inject the key through the service manager or container secret store. Avoid putting it in command arguments.

Try it first without sending telemetry:

    node index.js --dry-run

## What it sends

The JSON body contains this exact list of fields when health probing is enabled; without a health URL, the last two fields are omitted. The API key is sent separately in the `x-api-key` HTTP header for authentication.

    { "service": "api", "instance": "host-1", "timestamp": 1760000000000, "cpu": 42.1, "memory": 61.3, "network": 530,
      "http_status": 200, "response_ms": 18 }

- cpu: percent of CPU time in use between two readings
- memory: percent of RAM in use
- network: KB/s, Linux only (left out on Windows and macOS)
- http_status and response_ms: included only when `--health-url` is configured; status `0` means no response
- instance: host name by default; override with `--instance` to distinguish replicas

## What it never does

- It only reads these environment variables for configuration: `CLOUDREWIND_KEY`, `CLOUDREWIND_INSTANCE`, and `CLOUDREWIND_HEALTH_URL`. It does not enumerate or transmit environment variables.
- It never reads or sends source code, files, user data, request contents, health URL or response body.
- The optional health check makes a GET request from the agent machine, does not follow redirects, and records only status and time to response headers.
- It never opens a port or accepts commands. It only makes outbound requests.
- It needs no special permissions. Run it as a normal user.

## If the server is down

Readings are kept in memory (up to 120) and sent when the connection returns. Retries slow down
automatically (2s, 4s, ... up to 60s). Press Ctrl+C to stop; it makes one last attempt to send.

## Stop sharing

Rotate the key or delete the project on the CloudRewind Projects page. The old key stops working immediately.
