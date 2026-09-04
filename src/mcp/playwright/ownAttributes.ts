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

/** What one DOM pass hands back to the two ref-minting lanes. */
export interface DomFacts {
  /** `backendDOMNodeId` → the element's own `attr=value` label. */
  ownLabels: Map<number, string>;
  /**
   * `backendDOMNodeId` of every element that OWNS a `contenteditable` region.
   *
   * A rich-text field is a `<div contenteditable="true">`, which the a11y tree
   * may report under any role at all — YouTube Studio's title and description
   * never reached `browser_snapshot({filter:'interactive'})`, so an agent that
   * asked for the actionable elements was told the page had none of the two it
   * came for (dogfood 2026-09-04). The attribute is the unambiguous statement
   * that the element takes typed text, so it is read here and joined back
   * through the same id the labels use.
   *
   * The HOST only, never its descendants: `editable` in the a11y tree is
   * inherited by every node inside the region, so trusting that would mint a
   * ref for each paragraph of a long document.
   */
  editableRoots: Set<number>;
}

export function emptyDomFacts(): DomFacts {
  return { ownLabels: new Map(), editableRoots: new Set() };
}

/**
 * Read the DOM-side facts the accessibility tree cannot carry, in one pass.
 *
 * Best-effort in the same way getPasswordFieldBackendIds is: a detached target
 * or a missing DOM domain costs the verifier its extra signal and nothing
 * else, because `own` is verify-only — an absent label abstains rather than
 * stops. An absent `editableRoots` likewise only returns the enumerator to the
 * roles it always used.
 *
 * `pierce: true` so a control inside a web component's shadow root is covered.
 * Same-process iframes come back too; their nodes are numbered in this
 * target's id space, so joining them is sound. An OUT-OF-PROCESS frame is a
 * different target with a colliding id space, which is why the caller applies
 * these maps to main-frame refs only.
 */
export async function getDomFacts(client: CdpSender): Promise<DomFacts> {
  const facts = emptyDomFacts();
  try {
    const doc = (await client.send('DOM.getDocument', { depth: -1, pierce: true })) as {
      root?: CdpDomNode;
    };
    if (doc?.root) indexDocument(doc.root, facts);
  } catch {
    /* no DOM domain / detached target — the verifier abstains */
  }
  return facts;
}

/**
 * Iterative rather than recursive: a deep DOM (a chat log, a deeply nested
 * table) is exactly the page this runs on, and blowing the stack here would
 * cost the snapshot its whole result.
 */
function indexDocument(root: CdpDomNode, facts: DomFacts): void {
  const stack: CdpDomNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as CdpDomNode;
    if (node.backendNodeId !== undefined && node.attributes && node.attributes.length > 0) {
      const label = labelFor(node.attributes);
      if (label.length > 0) facts.ownLabels.set(node.backendNodeId, label);
      if (isEditableHost(node.attributes)) facts.editableRoots.add(node.backendNodeId);
    }
    if (node.children) for (const child of node.children) stack.push(child);
    if (node.shadowRoots) for (const shadow of node.shadowRoots) stack.push(shadow);
    if (node.contentDocument) stack.push(node.contentDocument);
  }
}

/**
 * Does this element declare itself editable?
 *
 * The bare attribute (`<div contenteditable>`) means true, and so does
 * `plaintext-only`; only an explicit `false` opts out. Inheritance is NOT
 * followed on purpose — see DomFacts.editableRoots.
 */
function isEditableHost(attributes: readonly string[]): boolean {
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    if (attributes[i] !== 'contenteditable') continue;
    const value = attributes[i + 1].trim().toLowerCase();
    return value !== 'false';
  }
  return false;
}

function labelFor(attributes: readonly string[]): string {
  return ownAttributeLabel((wanted) => {
    for (let i = 0; i + 1 < attributes.length; i += 2) {
      if (attributes[i] === wanted) return attributes[i + 1];
    }
    return undefined;
  });
}
