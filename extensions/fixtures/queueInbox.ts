import { createInboxProtocol } from "../inboxProtocol.js";

const [stateRoot, paneId, id, content] = process.argv.slice(2);
if (!stateRoot || !paneId || !id || !content)
  throw new Error("state root, pane, id, and content are required");

createInboxProtocol({
  stateRoot,
  now: () => 123,
  newId: () => "temporary",
}).queue(paneId, {
  id,
  customType: "test",
  content,
  triggerTurn: true,
  deliverAs: "steer",
});
