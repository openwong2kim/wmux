// Whose OSC 133 mark is this: the shell's, or a program's running under it?
//
// Every OSC 133 reader in wmux (the prompt log, the agent detector's launch
// boundaries, the kitty and focus-mode resets, the prompt state the renderer
// keys on) takes a mark for the shell's. A program that writes its own marks
// while a shell command runs (Kimi Code CLI wraps every prompt of its own
// transcript in A, B and C) was then read as the shell prompting, launching
// and ending commands mid-reply (#2771).
//
// The shell writes C when a command starts and `D;<exit code>` when it ends,
// before its next prompt (shell-integration.ts, every supported shell). So
// between a C and the next `D;<exit code>` the shell is not at a prompt, and any
// A, B or C seen there was written by the running program. This module tracks
// that, at the stream source, and changes the kind byte of such a foreign mark
// to lower case (`ESC]133;a`). Every reader ignores a lowercase kind, so the
// ring, live output, replay and every consumer read one decision.
//
// That holds only for a shell that writes both: wmux's own integration (its
// D always carries the exit code) or an exec unit, which has no shell and
// starts running. A caller scans nothing else: a shell that never writes C
// would have a program's C read as its own, and one whose D has no exit code
// would never leave running. Such output passes through as it is.
//
// Rules:
//   - idle: A, B and D are the shell's; C is the shell's and starts running.
//   - running: A, B and C are foreign. D is the shell's only as `D;<int>`
//     (a digit, or a minus sign and a digit), which ends running; a bare D,
//     or `D;` with no number after, is foreign.
//   - Nothing is decided before the `;` after `133`, since `ESC]133` is also a
//     prefix of `ESC]1337;` (iTerm2's file and image escapes).
//   - No output is held. A mark split across reads is followed through a
//     carry. A kind byte that was already passed on cannot be changed: a D
//     whose kind byte ends a read keeps its case, and the state waits for the
//     bytes after it (a pending D). Readers then take that one foreign D for
//     the shell's; holding output back to avoid it would delay every read
//     that ends in a D, and a read ending exactly there is rare.
//
// Accepted: a nested shell with its own integration (pwsh, or ssh to a host
// with OSC 133) writes `D;<int>` too, which reads as the outer shell's command
// end. From there its marks are read as the shell's, as before #2771.
//
// Marks are ASCII, so the scanner reads the decoded text: a mark's UTF-16 code
// units have the same values as its UTF-8 bytes.

export type ShellMarkState = 'idle' | 'running';

/** Progress through `ESC ] 1 3 3 ; <kind>` and, for a D in running, its tail. */
const enum Match {
  None = 0,
  Esc = 1,
  Bracket = 2,
  One = 3,
  OneThree = 4,
  OneThreeThree = 5,
  Kind = 6,
  /** A D in running, its kind byte seen: waiting for `;`. */
  DSemi = 7,
  /** A D in running followed by `;`: waiting for a digit or a minus sign. */
  DDigit = 8,
  /** A D in running followed by `;-`: waiting for a digit. */
  DMinus = 9,
}

const ESC = 0x1b;
const LOWER = 0x20;
/** Every mark starts with these bytes. */
const OPENER = '\u001b]133';

export class ShellMarkIngress {
  private current: ShellMarkState;
  private match: Match = Match.None;
  /** For a pending D: the index of its kind byte in this read, or -1 when it was in an earlier one. */
  private dKind = -1;
  private reported = false;

  /** `onFirstLowered` runs once, the first time a read has a kind lowered. */
  constructor(initial: ShellMarkState = 'idle', private readonly onFirstLowered?: () => void) {
    this.current = initial;
  }

  get state(): ShellMarkState {
    return this.current;
  }

  /**
   * Whether `text` (a read, or its decoded text) can hold a mark or the start
   * of one, so it must be scanned. A read that cannot is passed through as is,
   * and the state cannot change on it.
   */
  wants(text: string): boolean {
    if (this.match !== Match.None || text.includes(OPENER)) return true;
    // `ESC`, `ESC]`, … `ESC]13` at the very end: the rest may come next read.
    // These are the only prefixes to look for: any longer one (`ESC]133`,
    // `ESC]133;`, …) holds the whole opener and matched the `includes` above.
    // So the ESC of a prefix the next read may finish is in the last
    // OPENER.length - 1 (4) characters.
    const end = text.slice(-(OPENER.length - 1));
    const tail = end.lastIndexOf('\u001b');
    return tail >= 0 && OPENER.startsWith(end.slice(tail));
  }

  /**
   * One read in stream order: returns it with the kind byte of every foreign
   * mark lowercased. With none lowered, `text` itself comes back.
   */
  apply(text: string): string {
    if (!this.wants(text)) return text;
    /** Indices of the kind bytes to lowercase, ascending. */
    const lower: number[] = [];
    for (let i = 0; i < text.length; i++) {
      if (this.match === Match.None) {
        // Outside a mark only an ESC can start one: skip to it.
        const esc = text.indexOf('\u001b', i);
        if (esc < 0) break;
        i = esc;
      }
      const b = text.charCodeAt(i);
      switch (this.match) {
        case Match.DSemi:
          if (b === 0x3b) { this.match = Match.DDigit; continue; }
          // A D in running that is not `D;<int>`: the program's.
          if (this.dKind >= 0) lower.push(this.dKind);
          break;
        case Match.DDigit:
        case Match.DMinus:
          // pwsh reports a native program's exit code as-is, and on Windows
          // that can be negative (`D;-1073741510` after Ctrl+C).
          if (this.match === Match.DDigit && b === 0x2d) { this.match = Match.DMinus; continue; }
          if (b >= 0x30 && b <= 0x39) {
            // `D;<int>`: the shell's command end, back at its prompt.
            this.current = 'idle';
            this.match = Match.None;
            this.dKind = -1;
            continue;
          }
          if (this.dKind >= 0) lower.push(this.dKind);
          break;
        case Match.Esc:
          if (b === 0x5d) { this.match = Match.Bracket; continue; }
          break;
        case Match.Bracket:
          if (b === 0x31) { this.match = Match.One; continue; }
          break;
        case Match.One:
          if (b === 0x33) { this.match = Match.OneThree; continue; }
          break;
        case Match.OneThree:
          if (b === 0x33) { this.match = Match.OneThreeThree; continue; }
          break;
        case Match.OneThreeThree:
          // `ESC]133;` arms the kind; anything else (`ESC]1337;`) is not a mark.
          if (b === 0x3b) { this.match = Match.Kind; continue; }
          break;
        case Match.Kind:
          this.match = Match.None;
          if (this.decide(b, i)) lower.push(i);
          continue;
        default:
          break;
      }
      // Not (or no longer) inside a mark: this byte may open the next one.
      if (this.match >= Match.DSemi) {
        this.match = Match.None;
        this.dKind = -1;
      }
      this.match = b === ESC ? Match.Esc : Match.None;
    }
    // The next read cannot change a kind byte this one passed on.
    if (this.match >= Match.DSemi) this.dKind = -1;
    if (lower.length === 0) return text;
    if (!this.reported) {
      this.reported = true;
      this.onFirstLowered?.();
    }
    let out = '';
    let last = 0;
    for (const i of lower) {
      out += text.slice(last, i) + String.fromCharCode(text.charCodeAt(i) | LOWER);
      last = i + 1;
    }
    return out + text.slice(last);
  }

  /** The kind byte `b` at index `i`. Returns true when it is foreign (to be lowercased). */
  private decide(b: number, i: number): boolean {
    if (b < 0x41 || b > 0x44) return false; // not A-D (already lowercase, or another kind)
    if (this.current === 'idle') {
      if (b === 0x43) this.current = 'running';
      return false;
    }
    if (b === 0x44) {
      // Running: whether this D is the shell's depends on what follows it.
      this.match = Match.DSemi;
      this.dKind = i;
      return false;
    }
    return true;
  }
}
