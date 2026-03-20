# Custom Keybindings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to bind keyboard shortcuts (F1~F12, custom combos) to terminal text input commands via the Settings UI.

**Architecture:** Custom keybindings stored in Zustand uiSlice as an array, persisted in SessionData. `useKeyboard` checks custom bindings after built-in shortcuts. Settings > Shortcuts tab gets a new "Custom Keybindings" section with add/edit/delete UI and a key capture modal.

**Tech Stack:** React, Zustand/Immer, existing i18n system, existing SettingsPanel components (SettingRow, Toggle, SectionLabel)

---

### Task 1: Data Model + Store

**Files:**
- Modify: `src/shared/types.ts:72-86` (add CustomKeybinding interface + SessionData field)
- Modify: `src/renderer/stores/slices/uiSlice.ts` (add state + actions)

- [ ] **Step 1: Add CustomKeybinding type to shared/types.ts**

After the `SessionData` interface, add:

```ts
// === Custom keybinding ===
export interface CustomKeybinding {
  id: string;
  key: string;        // e.g. 'F7', 'Ctrl+Shift+1'
  label: string;      // user-defined name
  command: string;    // text to send to terminal
  sendEnter: boolean; // append \n after command
}
```

Add to `SessionData`:
```ts
customKeybindings?: CustomKeybinding[];
```

- [ ] **Step 2: Add store state and actions to uiSlice.ts**

Add to `UISlice` interface:
```ts
// ─── Custom keybindings ──────────────────────────────────────────────
customKeybindings: CustomKeybinding[];
addKeybinding: (kb: Omit<CustomKeybinding, 'id'>) => void;
updateKeybinding: (id: string, kb: Partial<Omit<CustomKeybinding, 'id'>>) => void;
removeKeybinding: (id: string) => void;
```

Add to `createUISlice` implementation:
```ts
customKeybindings: [],

addKeybinding: (kb) => set((state) => {
  state.customKeybindings.push({
    id: generateId('kb'),
    ...kb,
  });
}),

updateKeybinding: (id, updates) => set((state) => {
  const idx = state.customKeybindings.findIndex((k) => k.id === id);
  if (idx !== -1) Object.assign(state.customKeybindings[idx], updates);
}),

removeKeybinding: (id) => set((state) => {
  state.customKeybindings = state.customKeybindings.filter((k) => k.id !== id);
}),
```

Import `generateId` from `../../../shared/types` at the top.

- [ ] **Step 3: Add persistence (save/load)**

In `src/renderer/components/Layout/AppLayout.tsx` saveSession, add:
```ts
customKeybindings: state.customKeybindings,
```

In `src/renderer/stores/slices/workspaceSlice.ts` loadSession, add:
```ts
if (data.customKeybindings) state.customKeybindings = data.customKeybindings;
```

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/renderer/stores/slices/uiSlice.ts src/renderer/components/Layout/AppLayout.tsx src/renderer/stores/slices/workspaceSlice.ts
git commit -m "feat: custom keybinding data model + store + persistence"
```

---

### Task 2: Keyboard Handler Integration

**Files:**
- Modify: `src/renderer/hooks/useKeyboard.ts`

- [ ] **Step 1: Add custom keybinding matching after built-in shortcuts**

At the end of the `handler` function in `useKeyboard.ts`, before the closing `};`, add:

```ts
// ─── Custom keybindings → terminal input ─────────────────────────
const { customKeybindings } = store.getState();
if (customKeybindings.length > 0) {
  const pressed = formatKeyCombo(ctrl, shift, alt, key);
  const match = customKeybindings.find((kb) => kb.key === pressed);
  if (match) {
    e.preventDefault();
    // Find active PTY and write command
    const state = store.getState();
    const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
    if (ws) {
      const findLeaf = (pane: import('../../shared/types').Pane): import('../../shared/types').PaneLeaf | null => {
        if (pane.type === 'leaf' && pane.id === ws.activePaneId) return pane;
        if (pane.type === 'branch') {
          for (const c of pane.children) {
            const found = findLeaf(c);
            if (found) return found;
          }
        }
        return null;
      };
      const leaf = findLeaf(ws.rootPane);
      if (leaf) {
        const surface = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
        if (surface?.ptyId) {
          const text = match.sendEnter ? match.command + '\n' : match.command;
          window.electronAPI.pty.write(surface.ptyId, text);
        }
      }
    }
    return;
  }
}
```

- [ ] **Step 2: Add formatKeyCombo helper at the top of the file**

```ts
/**
 * Convert a KeyboardEvent into a normalized key combo string.
 * e.g. Ctrl+Shift held, key='1' → 'Ctrl+Shift+1'
 *      no modifiers, key='F7' → 'F7'
 */
function formatKeyCombo(ctrl: boolean, shift: boolean, alt: boolean, key: string): string {
  const parts: string[] = [];
  if (ctrl) parts.push('Ctrl');
  if (shift) parts.push('Shift');
  if (alt) parts.push('Alt');

  // Normalize key name: single chars to uppercase, special keys as-is
  let normalizedKey = key;
  if (key.length === 1) {
    normalizedKey = key.toUpperCase();
  }
  parts.push(normalizedKey);
  return parts.join('+');
}
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/hooks/useKeyboard.ts
git commit -m "feat: custom keybinding execution in useKeyboard"
```

---

### Task 3: i18n Keys

**Files:**
- Modify: `src/renderer/i18n/locales/en.ts`
- Modify: `src/renderer/i18n/locales/ko.ts`
- Modify: `src/renderer/i18n/locales/ja.ts`
- Modify: `src/renderer/i18n/locales/zh.ts`

- [ ] **Step 1: Add translation keys to all 4 locale files**

New keys needed:

| Key | EN | KO | JA | ZH |
|-----|----|----|----|----|
| `settings.customKeybindings` | Custom Keybindings | 커스텀 키바인딩 | カスタムキーバインド | 自定义快捷键 |
| `settings.kb.add` | Add keybinding | 키바인딩 추가 | キーバインド追加 | 添加快捷键 |
| `settings.kb.key` | Key | 키 | キー | 按键 |
| `settings.kb.label` | Label | 이름 | 名前 | 名称 |
| `settings.kb.command` | Command | 명령어 | コマンド | 命令 |
| `settings.kb.sendEnter` | Send Enter | Enter 전송 | Enter送信 | 发送回车 |
| `settings.kb.pressKey` | Press a key... | 키를 누르세요... | キーを押してください... | 请按下按键... |
| `settings.kb.conflict` | Conflicts with built-in shortcut | 내장 단축키와 충돌 | 組み込みショートカットと競合 | 与内置快捷键冲突 |
| `settings.kb.delete` | Delete | 삭제 | 削除 | 删除 |
| `settings.kb.noBindings` | No custom keybindings yet | 커스텀 키바인딩 없음 | カスタムキーバインドなし | 暂无自定义快捷键 |

Add these keys to each locale file, before the closing `} as const;`. In en.ts they define `TranslationKey`, other locales are `Partial`.

- [ ] **Step 2: Remove the "not yet available" message key usage**

In `SettingsPanel.tsx`, the `settings.shortcutsNotAvailable` text will be replaced by the custom keybindings UI in Task 4. No action needed here yet.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/i18n/locales/en.ts src/renderer/i18n/locales/ko.ts src/renderer/i18n/locales/ja.ts src/renderer/i18n/locales/zh.ts
git commit -m "feat: i18n keys for custom keybindings"
```

---

### Task 4: Settings UI — Custom Keybindings Section

**Files:**
- Modify: `src/renderer/components/Settings/SettingsPanel.tsx` (TabShortcuts function)

- [ ] **Step 1: Add key capture state and conflict detection**

Inside `TabShortcuts`, after `const t = useT();`, add:

```ts
const customKeybindings = useStore((s) => s.customKeybindings);
const addKeybinding = useStore((s) => s.addKeybinding);
const updateKeybinding = useStore((s) => s.updateKeybinding);
const removeKeybinding = useStore((s) => s.removeKeybinding);

const [capturingFor, setCapturingFor] = useState<string | null>(null); // kb id or 'new'
const [newLabel, setNewLabel] = useState('');
const [newCommand, setNewCommand] = useState('');
const [newSendEnter, setNewSendEnter] = useState(true);
const [newKey, setNewKey] = useState('');

// Built-in shortcut keys for conflict detection
const BUILTIN_KEYS = new Set([
  'Ctrl+B', 'Ctrl+N', 'Ctrl+D', 'Ctrl+T', 'Ctrl+W', 'Ctrl+F',
  'Ctrl+K', 'Ctrl+I', 'Ctrl+,',
  'Ctrl+Shift+W', 'Ctrl+Shift+D', 'Ctrl+Shift+L', 'Ctrl+Shift+X',
  'Ctrl+Shift+H', 'Ctrl+Shift+R', 'Ctrl+Shift+U', 'Ctrl+Shift+O',
  'Ctrl+Shift+]', 'Ctrl+Shift+[', 'Ctrl+Shift+M',
]);

function isConflict(key: string): boolean {
  return BUILTIN_KEYS.has(key);
}
```

- [ ] **Step 2: Add KeyCapture overlay component inside TabShortcuts**

```tsx
// Key capture overlay — shown when user clicks a key field
function KeyCapture({ onCapture, onCancel }: { onCapture: (key: string) => void; onCancel: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { onCancel(); return; }

      const parts: string[] = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.shiftKey) parts.push('Shift');
      if (e.altKey) parts.push('Alt');
      let k = e.key;
      if (k.length === 1) k = k.toUpperCase();
      if (!['Control', 'Shift', 'Alt', 'Meta'].includes(k)) {
        parts.push(k);
        onCapture(parts.join('+'));
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onCapture, onCancel]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}
      onClick={onCancel}
    >
      <div
        className="px-8 py-6 rounded-xl text-center"
        style={{ backgroundColor: '#1e1e2e', border: '1px solid #89b4fa' }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-lg text-[#cdd6f4] font-mono mb-2">{t('settings.kb.pressKey')}</p>
        <p className="text-xs text-[#585b70]">ESC to cancel</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Replace the "not yet available" section with custom keybindings UI**

Replace the `<p>` tag with `settings.shortcutsNotAvailable` and add the custom keybindings section after the built-in shortcuts list:

```tsx
{/* Custom keybindings */}
<SectionLabel label={t('settings.customKeybindings')} />

{customKeybindings.length === 0 ? (
  <p className="text-[11px] text-[#585b70] px-1">{t('settings.kb.noBindings')}</p>
) : (
  <div className="flex flex-col gap-1.5">
    {customKeybindings.map((kb) => (
      <div
        key={kb.id}
        className="flex items-center gap-2 px-3 py-2 rounded-lg"
        style={{ backgroundColor: '#181825', border: '1px solid #313244' }}
      >
        {/* Key badge — click to re-capture */}
        <button
          className="text-[10px] font-mono px-2 py-0.5 rounded shrink-0"
          style={{ backgroundColor: '#313244', color: '#89b4fa', border: '1px solid #45475a', minWidth: 60 }}
          onClick={() => setCapturingFor(kb.id)}
        >
          {kb.key}
        </button>

        {/* Label */}
        <input
          className="flex-1 bg-transparent text-xs text-[#cdd6f4] outline-none min-w-0 font-mono"
          value={kb.label}
          onChange={(e) => updateKeybinding(kb.id, { label: e.target.value })}
          placeholder={t('settings.kb.label')}
        />

        {/* Command */}
        <input
          className="flex-1 bg-transparent text-xs text-[#a6adc8] outline-none min-w-0 font-mono"
          value={kb.command}
          onChange={(e) => updateKeybinding(kb.id, { command: e.target.value })}
          placeholder={t('settings.kb.command')}
        />

        {/* Send Enter toggle */}
        <Toggle
          checked={kb.sendEnter}
          onChange={(v) => updateKeybinding(kb.id, { sendEnter: v })}
          label={t('settings.kb.sendEnter')}
        />

        {/* Delete */}
        <button
          className="text-[#6c7086] hover:text-[#f38ba8] text-xs transition-colors shrink-0"
          onClick={() => removeKeybinding(kb.id)}
          title={t('settings.kb.delete')}
        >
          ✕
        </button>
      </div>
    ))}
  </div>
)}

{/* Add button */}
<button
  className="mt-2 px-3 py-1.5 rounded-lg text-xs font-mono transition-colors"
  style={{ backgroundColor: '#313244', color: '#a6e3a1', border: '1px solid #45475a' }}
  onClick={() => setCapturingFor('new')}
>
  + {t('settings.kb.add')}
</button>

{/* Key capture overlay */}
{capturingFor && (
  <KeyCapture
    onCapture={(key) => {
      if (capturingFor === 'new') {
        addKeybinding({ key, label: '', command: '', sendEnter: true });
      } else {
        if (isConflict(key)) {
          // Show warning but still allow (user choice)
        }
        updateKeybinding(capturingFor, { key });
      }
      setCapturingFor(null);
    }}
    onCancel={() => setCapturingFor(null)}
  />
)}
```

- [ ] **Step 4: Add useState import if not already present**

`useState` should already be imported at the top of SettingsPanel.tsx. Verify.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Settings/SettingsPanel.tsx
git commit -m "feat: custom keybindings UI in Settings > Shortcuts"
```

---

### Task 5: Conflict Warning

**Files:**
- Modify: `src/renderer/components/Settings/SettingsPanel.tsx` (KeyCapture onCapture handler)

- [ ] **Step 1: Show conflict warning when capturing a key that conflicts with built-in shortcuts**

Update the `onCapture` callback in the KeyCapture invocation to show a brief visual indicator. In the keybinding row, add a conflict indicator:

After the key badge button in the customKeybindings map, add:
```tsx
{isConflict(kb.key) && (
  <span className="text-[9px] text-[#f9e2af]" title={t('settings.kb.conflict')}>!</span>
)}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/components/Settings/SettingsPanel.tsx
git commit -m "feat: conflict warning for custom keybindings"
```

---

### Task 6: Final Verification

- [ ] **Step 1: Run TypeScript check**

```bash
npx tsc --noEmit
```

Verify no new errors related to custom keybindings.

- [ ] **Step 2: Manual test checklist**

1. Open Settings > Shortcuts tab
2. Click "+ Add keybinding" → key capture modal appears
3. Press F7 → new row appears with "F7" badge
4. Type label "Claude" and command "claude --dangerously-skip-permissions"
5. Toggle "Send Enter" on
6. Close settings, press F7 in terminal → command typed + Enter sent
7. Close and reopen app → keybinding persists
8. Try binding Ctrl+B → conflict warning "!" shown
9. Delete the keybinding → row removed

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: complete custom keybindings feature"
```
