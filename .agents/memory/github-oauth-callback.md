---
name: GitHub OAuth callback
description: Stable callback URL requirements for the Axis GitHub OAuth App.
---

GitHub OAuth Apps require one exact callback URL. Axis should use a canonical callback URL (configured explicitly for a deployed app, or the stable Replit development domain), while treating the changing preview page as a post-authentication return destination only.

**Why:** GitHub rejects authorization requests when the callback URL changes or differs from the OAuth App setting; preview/proxy hosts are not reliable registration targets.

**How to apply:** Keep the callback endpoint fixed, expose the exact computed URL in Settings for copying, validate OAuth state before clearing it, and never let an arbitrary external `returnTo` become an open redirect.