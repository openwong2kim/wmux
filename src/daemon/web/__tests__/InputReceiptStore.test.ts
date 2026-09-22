import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { InputReceiptStore } from '../InputReceiptStore';
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(),'wmux-input-receipt-')); });
afterEach(() => { fs.rmSync(root,{recursive:true,force:true}); });

it('deduplicates exact writes across reconstruction without storing input text', () => {
  const now = Date.now(); const id = `${now}.${randomUUID()}`; let writes = 0;
  const store = new InputReceiptStore(root,() => now);
  expect(store.execute('phone','' + id,'pane/incarnation','secret text',() => { writes++; })).toEqual({status:'written',replayed:false});
  const restored = new InputReceiptStore(root,() => now);
  expect(restored.execute('phone',id,'pane/incarnation','secret text',() => { writes++; })).toEqual({status:'written',replayed:true});
  expect(writes).toBe(1);
  expect(fs.readFileSync(path.join(root,'phone-input-receipts.json'),'utf8')).not.toContain('secret text');
  expect(() => restored.execute('phone',id,'different pane','secret text',() => { writes++; })).toThrow(/different content/);
  expect(writes).toBe(1);
});

it('does not repeat a possibly partial PTY write after restart', () => {
  const now = Date.now(); const id = `${now}.${randomUUID()}`; let writes = 0;
  const store = new InputReceiptStore(root,() => now);
  expect(store.execute('phone',id,'pane','request',() => { writes++; throw new Error('partial write'); }).status).toBe('uncertain');
  expect(new InputReceiptStore(root,() => now).execute('phone',id,'pane','request',() => { writes++; })).toEqual({status:'uncertain',replayed:true});
  expect(writes).toBe(1);
});

it('rejects expired IDs after cleanup and enforces bounded capacity', () => {
  let now = Date.now(); const old = `${now}.${randomUUID()}`;
  const store = new InputReceiptStore(root,() => now,1);
  store.execute('phone',old,'pane','a',() => { /* noop */ });
  expect(() => store.execute('phone',`${now}.${randomUUID()}`,'pane','b',() => { /* noop */ })).toThrow(/capacity/);
  now += 25 * 60 * 60 * 1000;
  store.execute('phone',`${now}.${randomUUID()}`,'pane','b',() => { /* noop */ });
  expect(() => store.execute('phone',old,'pane','a',() => { /* noop */ })).toThrow(/expired/);
});

it('refuses corrupt storage instead of forgetting prior inputs', () => {
  fs.writeFileSync(path.join(root,'phone-input-receipts.json'),'{broken');
  expect(() => new InputReceiptStore(root)).toThrow();
});

it('does not write to the PTY when the pending receipt cannot be persisted', () => {
  const unavailable = path.join(root,'not-a-directory');
  fs.writeFileSync(unavailable,'occupied');
  const now = Date.now(); let writes = 0;
  const store = new InputReceiptStore(unavailable,() => now);
  expect(() => store.execute('phone',`${now}.${randomUUID()}`,'pane','input',() => { writes++; })).toThrow();
  expect(writes).toBe(0);
});
