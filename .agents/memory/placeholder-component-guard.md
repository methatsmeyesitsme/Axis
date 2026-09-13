---
name: Placeholder component guard
description: A source file replaced by a placeholder can surface as a misleading Vite default-export error.
---

When a Vite module reports that a component does not provide a default export, first inspect the component file itself for placeholder content before changing import/export syntax.

**Why:** A committed placeholder in a component source file produced the same runtime symptom as a broken export and was only distinguishable by checking the file contents.

**How to apply:** Check the reported module, its importing module, and recent history. Restore the real component implementation when the file contains placeholder text, then restart Vite to clear the stale module graph.