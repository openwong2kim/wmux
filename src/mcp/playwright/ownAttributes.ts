// ---------------------------------------------------------------------------
// The element's own identifying attribute, read once per snapshot.
//
// Both minting lanes walk the ACCESSIBILITY tree (snapshot.ts serializeNode,
// dom-intelligence collectInteractiveElements), and an a11y node carries no
// DOM attributes at all — only a `backendDOMNodeId`. So the attributes have to
// come from the DOM domain and be joined back through that id, exactly the
// bridge redact.ts already uses to find password fields.
//
// One `DOM.getDocument` for the whole document, not one lookup per ref: a
// per-ref `DOM.describeNode` would be a round trip per interactive element on
// a page that has hundreds, which is the cost that would make this feature not
// worth having. The single pass is the same order as the `getFullAXTree` call
// the snapshot already makes, and everything after it is local.
//
// Only nodes that actually carry one of the four attributes get a map entry,
// so the map that survives the pass is small even when the document is not.
// ---------------------------------------------------------------------------

import { ownAttributeLabel } from '../../shared/browserReplay/actionTrace';

type CdpSender = { send: (method: string, params?: unknown) => Promise<unknown> };

/** The `DOM.getDocument` node fields this pass reads. */
interface CdpDomNode {
  backendNodeId?: number;
  /** Flat `[name, value, name, value, ...]`, which is how CDP ships them. */
  attributes?: string[];
  children?: CdpDomNode[];
  shadowRoots?: CdpDomNode[];
  contentDocument?: CdpDomNode;
}

/**
 * `backendDOMNodeId` → the element's own `attr=value` label, for every element
 * in the document that has one.
 *
 * Best-effort in the same way getPasswordFieldBackendIds is: a detached target
 * or a missing DOM domain costs the verifier its extra signal and nothing
 * else, because `own` is verify-only — an absent label abstains rather than
 * stops.
 *
 * `pierce: true` so a control inside a web component's shadow root is covered.
 * Same-process iframes come back too; their nodes are numbered in this
 * target's id space, so joining them is sound. An OUT-OF-PROCESS frame is a
 * different target with a colliding id space, which is why the caller applies
 * this map to main-frame refs only.
 */
export async function getOwnAttributeLabels(client: CdpSender): Promise<Map<number, string>> {
  const labels = new Map<number, string>();
  try {
    const doc = (await client.send('DOM.getDocument', { depth: -1, pierce: true })) as {
      root?: CdpDomNode;
    };
    if (doc?.root) indexDocument(doc.root, labels);
  } catch {
    /* no DOM domain / detached target — the verifier abstains */
  }
  return labels;
}

/**
 * Iterative rather than recursive: a deep DOM (a chat log, a deeply nested
 * table) is exactly the page this runs on, and blowing the stack here would
 * cost the snapshot its whole result.
 */
function indexDocument(root: CdpDomNode, labels: Map<number, string>): void {
  const stack: CdpDomNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as CdpDomNode;
    if (node.backendNodeId !== undefined && node.attributes && node.attributes.length > 0) {
      const label = labelFor(node.attributes);
      if (label.length > 0) labels.set(node.backendNodeId, label);
    }
    if (node.children) for (const child of node.children) stack.push(child);
    if (node.shadowRoots) for (const shadow of node.shadowRoots) stack.push(shadow);
    if (node.contentDocument) stack.push(node.contentDocument);
  }
}

function labelFor(attributes: readonly string[]): string {
  return ownAttributeLabel((wanted) => {
    for (let i = 0; i + 1 < attributes.length; i += 2) {
      if (attributes[i] === wanted) return attributes[i + 1];
    }
    return undefined;
  });
}
