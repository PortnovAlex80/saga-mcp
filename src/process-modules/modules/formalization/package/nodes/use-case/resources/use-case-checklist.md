# Use-case node checklist

> Package-local checklist for the `model-use-cases` node. Every item MUST be
> ticked before `worker_done`. Wave 8 pinned resource (W8-A3).

- [ ] Read the exact upstream product production (PRD + FR ids) from durable bindings.
- [ ] Created at least one `UC` artifact in `draft` status from the call template.
- [ ] Each UC has a `derived_from` trace to the exact PRD artifact.
- [ ] Each UC has a `covers` trace to at least one exact FR artifact.
- [ ] Every accepted FR is covered by at least one UC (no uncovered FR).
- [ ] No UC was self-accepted; all UCs remain `draft`/`in_review` for the kernel gate.
- [ ] No PRD/FR/NFR/RULE/AC/SRS artifact was created or modified from this node.
- [ ] Stage tracker updated as the program counter; recovery checkpoint recorded.
