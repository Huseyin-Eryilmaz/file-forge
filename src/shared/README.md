# Shared contract

`contract.ts` describes the shapes the HTTP API speaks, and is imported by
both the server and the browser.

The rule that makes this work: **nothing in here may import a server
dependency.** No Express, no Redis, no BullMQ, no `node:fs` — only Zod and
plain types. Break that rule and the frontend bundle either fails to build
or quietly drags a server library into the browser.

The benefit is that drift becomes a compile error. Rename a field here and
the frontend stops building, rather than reading `undefined` at runtime in
a browser somewhere.
