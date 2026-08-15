# Readiness certification checklist

- Read the exact integrated-source ProductRef and payload supplied upstream.
- Inspect the exact committed repository tree; do not use a moving branch as authority.
- Declare one `primary` target with explicit install, complete test and (for a service) start commands.
- Copy sourceCandidate schema/ref/hash exactly.
- Submit `factory.development-readiness-manifest.v1`; then call `worker_done`.
- For a served target, bind the service to the Factory-provided `PORT`
  environment variable; never hardcode a numeric port in `startCommand`.
- If the Gate executes a command unsuccessfully, repair this manifest and resubmit.
