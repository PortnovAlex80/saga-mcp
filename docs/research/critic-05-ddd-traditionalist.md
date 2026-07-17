# Critic 5: DDD/Bounded-Context Traditionalist

> **Verdict:** "Proposal preserves skeleton of DDD while removing organ that produces meaning. What remains is wax fruit arrangement — photographs well, nourishes nothing."

## Six critiques

1. **Bounded Context without conversation is just module boundary.** BC is *discovered* through translational friction, not drawn. Brandolini's Event Storming invented because architects declaring BCs from first principles got them wrong.

2. **Ubiquitous Language without domain expert is just naming.** UL's value is negotiation trace — "we used to disagree, here is what we decided." Glossary authored by LLM alone records guess. Brandolini: "value is in the crunching, not the crunched."

3. **Aggregate = "largest unit one worker can implement" optimizes wrong axis.** Aggregate is *consistency boundary defined by invariants*, not worker convenience. Inverting cause/effect: letting parallelism drive Aggregate identification.

4. **Domain Events → "recorded observations" loses modeling tool.** Domain Event is discovery concept ("what do experts care about?"), entry point to model. runtime_observation is operational telemetry. Different objects at different layers.

5. **Context Mapping → conflict_key types loses relationship semantics.** Customer-Supplier carries power asymmetry. Conformist is deliberate submission. ACL signals distrust. conflict_key says "two tasks touch same file" — collapses four coordination strategies.

6. **"BC maps to project_repository" conflates domain unit with deployment unit.** BC is linguistic boundary, not deployment. Many-to-many: one BC spans repos, one repo contains BCs. Original sin of 2014-2018 microservices era.

## Where proposal HELPS DDD

1. **Context Map becomes living queryable artifact** instead of forgotten whiteboard photo
2. **Aggregate invariants become first-class machine-checkable artifacts** — enforcement DDD wanted for 15 years
3. **Event-log-as-default forces eventual-consistency discipline** DDD preached but rarely saw built

## Key insight

Must find agent-runtime substitute for *conversation*, not just coordination overhead. Structured way for LLM architect to interrogate domain expert; recorded negotiation trace for UL; Event Storming artifact type before SRS.
