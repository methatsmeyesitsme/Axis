---
name: Forge local model guard
description: Forge's local tool loop must avoid loading the optional larger model in the API process.
---

The larger local model must be opt-in, and Forge/local tool turns should request the fast model explicitly; the larger model can exceed the API process memory budget and terminate the whole workflow.

**Why:** A guest Forge request loaded the larger model and the API was killed with exit 137, while the fast model completed without taking down the service.

**How to apply:** Keep the larger model available only when `LOCAL_MODEL_ALLOW_LARGE` is explicitly enabled, and pass the fast-model option through Forge's local agent path.