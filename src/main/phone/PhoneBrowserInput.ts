import type { WebContents } from 'electron';

const active = new Set<number>();

/** CDP text insertion requires focus even when Tab changed the active DOM node. */
export async function withPhoneBrowserInputFocus<T>(contents: WebContents, operation: () => Promise<T>): Promise<T> {
  if (contents.isDestroyed() || active.has(contents.id)) throw new Error('Browser input unavailable');
  active.add(contents.id);
  let emulated = false;
  try {
    contents.focus();
    await contents.debugger.sendCommand('Page.bringToFront');
    const state = await contents.debugger.sendCommand('Runtime.evaluate', {
      expression: 'document.hasFocus()', returnByValue: true,
    }) as {result?:{value?:unknown}};
    if (state.result?.value !== true) {
      await contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:true});
      emulated = true;
    }
    return await operation();
  } finally {
    try {
      if (emulated && !contents.isDestroyed()) {
        await contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:false});
      }
    } finally { active.delete(contents.id); }
  }
}

/** Update Chromium's pointer hit-test target before dispatching a wheel event. */
export async function dispatchPhoneBrowserScroll(contents: WebContents, event: {x:number;y:number;deltaX:number;deltaY:number}): Promise<void> {
  await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type:'mouseMoved',x:event.x,y:event.y,button:'none',buttons:0,
  });
  await contents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseWheel',...event});
}

/** Read the real embedded widget bounds from wmux's renderer, not the web page. */
export async function phoneBrowserNativeBounds(contents: WebContents): Promise<{width:number;height:number}> {
  const host = contents.hostWebContents;
  if (!host || host.isDestroyed()) throw new Error('Browser host unavailable');
  const bounds = await host.executeJavaScript(`(() => {
    for (const view of document.querySelectorAll('webview')) {
      try {
        if (view.getWebContentsId() === ${contents.id}) {
          const rect = view.getBoundingClientRect();
          return {width:rect.width,height:rect.height};
        }
      } catch {}
    }
    return null;
  })()`) as {width?:unknown;height?:unknown} | null;
  if (!bounds || typeof bounds.width !== 'number' || typeof bounds.height !== 'number' ||
      !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0) throw new Error('Browser bounds unavailable');
  const scale = host.getZoomFactor() / contents.getZoomFactor();
  return {width:bounds.width * scale,height:bounds.height * scale};
}
