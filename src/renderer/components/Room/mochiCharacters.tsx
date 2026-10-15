// ─── The Mochi crew: the bots' characters ────────────────────────────────────
//
// GENERATED from the owner-approved "Mochi Orb Crew v2" design (2026-10-16,
// drawn by Grok). One character per bot identity colour: MOCHI_CHARACTERS[i]
// wears BOT_IDENTITY_HUES[i] (BotAvatar.tsx) as its body colour. Each art
// takes the instance's own gradient id, so two of the same character on one
// page never share an id. The motion lives in botAvatar.css, keyed on the
// `wmux-moN-*` and `wmux-mochi-*` classes.

interface ArtProps {
  /** This instance's gradient id. */
  gid: string;
}

export interface MochiCharacter {
  name: string;
  /** The body colour: the identity hue of this slot. */
  body: string;
  Art: (props: ArtProps) => React.ReactElement;
}

function LoafArt({ gid }: ArtProps): React.ReactElement {
  const fill = `url(#${gid})`;
  return (
    <>
      <defs>
        <radialGradient id={gid} cx="36%" cy="30%" r="74%">
          <stop offset="0%" stopColor="#7ea6ff" />
          <stop offset="44%" stopColor="#3d6ff5" />
          <stop offset="100%" stopColor="#244db8" />
        </radialGradient>
      </defs>
      <g className="wmux-mochi-body wmux-mo4-root">
        <ellipse cx="8.4" cy="22.15" rx="3.05" ry="1.65" fill="#244db8" />
        <ellipse cx="15.6" cy="22.15" rx="3.05" ry="1.65" fill="#244db8" />
        <ellipse cx="8.4" cy="21.55" rx="3.05" ry="1.65" fill={fill} />
        <ellipse cx="15.6" cy="21.55" rx="3.05" ry="1.65" fill={fill} />
        <ellipse cx="8.15" cy="21.2" rx="1.1" ry=".42" fill="#fff" opacity=".22" />
        <ellipse cx="15.35" cy="21.2" rx="1.1" ry=".42" fill="#fff" opacity=".22" />
        <g className="wmux-mochi-sig wmux-mo4-earL">
          <ellipse cx="7.35" cy="5.15" rx="1.9" ry="3.2" fill="#244db8" transform="rotate(-26 7.35 5.15)" />
          <ellipse cx="7.35" cy="4.65" rx="1.9" ry="3.2" fill={fill} transform="rotate(-26 7.35 4.65)" />
          <ellipse cx="7.65" cy="4.95" rx=".8" ry="1.7" fill="#ffb3c8" opacity=".55" transform="rotate(-26 7.65 4.95)" />
        </g>
        <g className="wmux-mochi-sig wmux-mo4-earR">
          <ellipse cx="16.65" cy="5.15" rx="1.9" ry="3.2" fill="#244db8" transform="rotate(26 16.65 5.15)" />
          <ellipse cx="16.65" cy="4.65" rx="1.9" ry="3.2" fill={fill} transform="rotate(26 16.65 4.65)" />
          <ellipse cx="16.35" cy="4.95" rx=".8" ry="1.7" fill="#ffb3c8" opacity=".55" transform="rotate(26 16.35 4.95)" />
        </g>
        <rect x="3.45" y="7.05" width="17.1" height="14.6" rx="6.6" fill="#244db8" />
        <rect x="3.45" y="6.55" width="17.1" height="14.6" rx="6.6" fill={fill} />
        <ellipse cx="12.1" cy="16.7" rx="6.2" ry="3.5" fill="#244db8" opacity=".2" />
        <ellipse cx="12" cy="16.9" rx="5.3" ry="2.8" fill="#a8c2ff" opacity=".26" />
        <ellipse cx="8.5" cy="10.4" rx="3.4" ry="2.2" fill="#fff" opacity=".34" />
        <ellipse cx="16.7" cy="11.6" rx=".7" ry="3.2" fill="#fff" opacity=".15" transform="rotate(12 16.7 11.6)" />
        <path d="M7.3 14.55C9.6 15.4 14.4 15.4 16.7 14.55" fill="none" stroke="#244db8" strokeWidth=".45" strokeLinecap="round" opacity=".45" />
        <path d="M7.7 16.15C9.8 16.9 14.2 16.9 16.3 16.15" fill="none" stroke="#244db8" strokeWidth=".4" strokeLinecap="round" opacity=".32" />
        <ellipse cx="4.55" cy="17.2" rx="1.2" ry="1.05" fill="#244db8" />
        <ellipse cx="4.55" cy="16.8" rx="1.2" ry="1.05" fill={fill} />
        <ellipse cx="19.45" cy="17.2" rx="1.2" ry="1.05" fill="#244db8" />
        <ellipse cx="19.45" cy="16.8" rx="1.2" ry="1.05" fill={fill} />
        <ellipse cx="6.6" cy="15.7" rx="1.7" ry="1.05" fill="#ffb3c8" opacity=".8" />
        <ellipse cx="17.4" cy="15.7" rx="1.7" ry="1.05" fill="#ffb3c8" opacity=".8" />
        <g className="wmux-mochi-eye wmux-mo4-eye">
          <ellipse cx="9.15" cy="12.85" rx="1.55" ry="1.7" fill="#23213a" />
          <ellipse cx="9.6" cy="12.15" rx=".85" ry=".85" fill="#fff" />
          <ellipse cx="8.62" cy="13.4" rx=".3" ry=".32" fill="#fff" />
        </g>
        <g className="wmux-mochi-eye wmux-mo4-eye">
          <ellipse cx="14.85" cy="12.85" rx="1.55" ry="1.7" fill="#23213a" />
          <ellipse cx="15.3" cy="12.15" rx=".85" ry=".85" fill="#fff" />
          <ellipse cx="14.32" cy="13.4" rx=".3" ry=".32" fill="#fff" />
        </g>
        <path d="M9.35 15.7C10.5 18 13.5 18 14.65 15.7C13.35 16.85 10.65 16.85 9.35 15.7Z" fill="#23213a" />
        <ellipse cx="12" cy="16.55" rx=".7" ry=".28" fill="#fff" opacity=".25" />
      </g>
    </>
  );
}

function NovaArt({ gid }: ArtProps): React.ReactElement {
  const fill = `url(#${gid})`;
  return (
    <>
      <defs>
        <radialGradient id={gid} cx="36%" cy="32%" r="74%">
          <stop offset="0%" stopColor="#9a9af2" />
          <stop offset="44%" stopColor="#5b5bd6" />
          <stop offset="100%" stopColor="#3a36a8" />
        </radialGradient>
      </defs>
      <g className="wmux-mochi-body wmux-mo2-root">
        <g className="wmux-mochi-sig wmux-mo2-ant">
          <circle cx="15.35" cy="2.7" r="1.7" fill="#3a36a8" />
          <path d="M12.3 6.1Q14.5 4.2 15.1 2.7" fill="none" stroke="#3a36a8" strokeWidth="1.7" strokeLinecap="round" />
          <path d="M12.3 5.6Q14.5 3.7 15.1 2.2" fill="none" stroke="#5b5bd6" strokeWidth="1.7" strokeLinecap="round" />
          <circle cx="15.35" cy="2.2" r="1.7" fill={fill} />
          <circle cx="14.85" cy="1.72" r=".55" fill="#fff" opacity=".5" />
          <circle cx="15.7" cy="2.55" r=".22" fill="#fff" opacity=".7" />
        </g>
        <ellipse cx="8.6" cy="22.15" rx="2.9" ry="1.65" fill="#3a36a8" />
        <ellipse cx="15.4" cy="22.15" rx="2.9" ry="1.65" fill="#3a36a8" />
        <ellipse cx="8.6" cy="21.6" rx="2.9" ry="1.65" fill={fill} />
        <ellipse cx="15.4" cy="21.6" rx="2.9" ry="1.65" fill={fill} />
        <ellipse cx="8.35" cy="21.25" rx="1.05" ry=".42" fill="#fff" opacity=".22" />
        <ellipse cx="15.15" cy="21.25" rx="1.05" ry=".42" fill="#fff" opacity=".22" />
        <ellipse cx="12" cy="14.3" rx="7.7" ry="8.95" fill="#3a36a8" />
        <ellipse cx="12" cy="13.8" rx="7.7" ry="8.95" fill={fill} />
        <ellipse cx="12.15" cy="17.3" rx="4.8" ry="4.2" fill="#3a36a8" opacity=".2" />
        <ellipse cx="12" cy="17.6" rx="4.1" ry="3.4" fill="#c5c5ff" opacity=".26" />
        <ellipse cx="8.8" cy="10.2" rx="3.1" ry="2.2" fill="#fff" opacity=".34" />
        <ellipse cx="16.2" cy="12.1" rx=".7" ry="3.1" fill="#fff" opacity=".15" transform="rotate(16 16.2 12.1)" />
        <path d="M12 14.85l.32.95.95.32-.95.32-.32.95-.32-.95-.95-.32.95-.32z" fill="#fff" opacity=".38" />
        <ellipse cx="5.35" cy="18.15" rx="1.15" ry="1" fill="#3a36a8" />
        <ellipse cx="5.35" cy="17.75" rx="1.15" ry="1" fill={fill} />
        <ellipse cx="18.65" cy="18.15" rx="1.15" ry="1" fill="#3a36a8" />
        <ellipse cx="18.65" cy="17.75" rx="1.15" ry="1" fill={fill} />
        <ellipse cx="7.1" cy="16" rx="1.6" ry="1" fill="#ffb3c8" opacity=".8" />
        <ellipse cx="16.9" cy="16" rx="1.6" ry="1" fill="#ffb3c8" opacity=".8" />
        <g className="wmux-mochi-eye wmux-mo2-eye">
          <ellipse cx="9.2" cy="13.05" rx="1.75" ry="2.15" fill="#23213a" />
          <ellipse cx="9.75" cy="12.2" rx=".85" ry=".9" fill="#fff" />
          <ellipse cx="8.62" cy="13.75" rx=".32" ry=".38" fill="#fff" />
        </g>
        <g className="wmux-mochi-eye wmux-mo2-eye">
          <ellipse cx="14.8" cy="13.05" rx="1.75" ry="2.15" fill="#23213a" />
          <ellipse cx="15.35" cy="12.2" rx=".85" ry=".9" fill="#fff" />
          <ellipse cx="14.22" cy="13.75" rx=".32" ry=".38" fill="#fff" />
        </g>
        <circle cx="12" cy="16.35" r="1.2" fill="#23213a" />
        <ellipse cx="12" cy="16.05" rx=".55" ry=".4" fill="#fff" opacity=".45" />
      </g>
    </>
  );
}

function PlumeArt({ gid }: ArtProps): React.ReactElement {
  const fill = `url(#${gid})`;
  return (
    <>
      <defs>
        <radialGradient id={gid} cx="36%" cy="32%" r="72%">
          <stop offset="0%" stopColor="#b48af2" />
          <stop offset="44%" stopColor="#7c4ddb" />
          <stop offset="100%" stopColor="#4e289e" />
        </radialGradient>
      </defs>
      <g className="wmux-mochi-body wmux-mo6-root">
        <ellipse cx="8.4" cy="22.1" rx="3.05" ry="1.65" fill="#4e289e" />
        <ellipse cx="15.6" cy="22.1" rx="3.05" ry="1.65" fill="#4e289e" />
        <ellipse cx="8.4" cy="21.55" rx="3.05" ry="1.65" fill={fill} />
        <ellipse cx="15.6" cy="21.55" rx="3.05" ry="1.65" fill={fill} />
        <ellipse cx="8.15" cy="21.2" rx="1.1" ry=".42" fill="#fff" opacity=".22" />
        <ellipse cx="15.35" cy="21.2" rx="1.1" ry=".42" fill="#fff" opacity=".22" />
        <g className="wmux-mochi-sig wmux-mo6-tuft">
          <path d="M10.3 8.15C7.4 7.9 6.55 3.85 9.9 2.35C13.85 .7 17.7 3.35 16.35 6.55C15.7 8.15 13.45 8.4 12.55 6.85C12.15 7.95 11.2 8.2 10.3 8.15Z" fill="#4e289e" />
          <path d="M10.3 7.6C7.4 7.35 6.55 3.3 9.9 1.8C13.85 .15 17.7 2.8 16.35 6C15.7 7.6 13.45 7.85 12.55 6.3C12.15 7.4 11.2 7.65 10.3 7.6Z" fill={fill} />
          <path d="M9.7 5.1C9.15 3.7 10.7 2.55 12.05 3.15C13.1 3.6 13.35 4.7 12.7 5.45C12.2 5.1 10.55 5.55 9.7 5.1Z" fill="#d2b4ff" opacity=".45" />
        </g>
        <circle cx="12" cy="14.05" r="8.35" fill="#4e289e" />
        <circle cx="12" cy="13.5" r="8.35" fill={fill} />
        <ellipse cx="12.15" cy="16.7" rx="5.2" ry="3.9" fill="#4e289e" opacity=".2" />
        <ellipse cx="12" cy="17" rx="4.4" ry="3.15" fill="#c9a6ff" opacity=".28" />
        <ellipse cx="8.5" cy="10.2" rx="3.4" ry="2.25" fill="#fff" opacity=".34" />
        <ellipse cx="16.5" cy="11.5" rx=".75" ry="3.15" fill="#fff" opacity=".15" transform="rotate(16 16.5 11.5)" />
        <circle cx="12" cy="16.55" r=".28" fill="#fff" opacity=".45" />
        <circle cx="11.15" cy="17.25" r=".22" fill="#fff" opacity=".32" />
        <circle cx="12.85" cy="17.25" r=".22" fill="#fff" opacity=".32" />
        <circle cx="12" cy="17.95" r=".22" fill="#fff" opacity=".28" />
        <ellipse cx="5.05" cy="17.55" rx="1.2" ry="1.02" fill="#4e289e" />
        <ellipse cx="5.05" cy="17.15" rx="1.2" ry="1.02" fill={fill} />
        <ellipse cx="18.95" cy="17.55" rx="1.2" ry="1.02" fill="#4e289e" />
        <ellipse cx="18.95" cy="17.15" rx="1.2" ry="1.02" fill={fill} />
        <ellipse cx="6.7" cy="15.65" rx="1.7" ry="1.05" fill="#ffb3c8" opacity=".8" />
        <ellipse cx="17.3" cy="15.65" rx="1.7" ry="1.05" fill="#ffb3c8" opacity=".8" />
        <g className="wmux-mochi-eye wmux-mo6-eye">
          <ellipse cx="9" cy="12.7" rx="1.85" ry="2.25" fill="#23213a" />
          <ellipse cx="9.55" cy="11.85" rx=".9" ry=".95" fill="#fff" />
          <ellipse cx="8.4" cy="13.4" rx=".34" ry=".4" fill="#fff" />
        </g>
        <g className="wmux-mochi-eye wmux-mo6-eye">
          <ellipse cx="15" cy="12.7" rx="1.85" ry="2.25" fill="#23213a" />
          <ellipse cx="15.55" cy="11.85" rx=".9" ry=".95" fill="#fff" />
          <ellipse cx="14.4" cy="13.4" rx=".34" ry=".4" fill="#fff" />
        </g>
        <path d="M10.15 16C10.85 17.35 13.15 17.35 13.85 16C12.9 16.8 11.1 16.8 10.15 16Z" fill="#23213a" />
        <ellipse cx="12" cy="16.55" rx=".55" ry=".22" fill="#fff" opacity=".25" />
      </g>
    </>
  );
}

function WinkArt({ gid }: ArtProps): React.ReactElement {
  const fill = `url(#${gid})`;
  return (
    <>
      <defs>
        <radialGradient id={gid} cx="36%" cy="32%" r="72%">
          <stop offset="0%" stopColor="#c275ea" />
          <stop offset="44%" stopColor="#9d3fd1" />
          <stop offset="100%" stopColor="#6c2098" />
        </radialGradient>
      </defs>
      <g className="wmux-mochi-body wmux-mo8-root">
        <ellipse cx="8.4" cy="22.15" rx="3.05" ry="1.65" fill="#6c2098" />
        <ellipse cx="15.6" cy="22.15" rx="3.05" ry="1.65" fill="#6c2098" />
        <ellipse cx="8.4" cy="21.55" rx="3.05" ry="1.65" fill={fill} />
        <ellipse cx="15.6" cy="21.55" rx="3.05" ry="1.65" fill={fill} />
        <ellipse cx="8.15" cy="21.2" rx="1.1" ry=".42" fill="#fff" opacity=".22" />
        <ellipse cx="15.35" cy="21.2" rx="1.1" ry=".42" fill="#fff" opacity=".22" />
        <g className="wmux-mochi-sig wmux-mo8-puff">
          <circle cx="6.75" cy="5.7" r="2.55" fill="#6c2098" />
          <circle cx="12" cy="4.15" r="3.05" fill="#6c2098" />
          <circle cx="17.25" cy="5.7" r="2.55" fill="#6c2098" />
          <circle cx="6.75" cy="5.2" r="2.55" fill={fill} />
          <circle cx="12" cy="3.65" r="3.05" fill={fill} />
          <circle cx="17.25" cy="5.2" r="2.55" fill={fill} />
          <circle cx="6.2" cy="4.55" r="1.15" fill="#e3b0f8" opacity=".5" />
          <circle cx="11.25" cy="2.85" r="1.35" fill="#e3b0f8" opacity=".5" />
          <circle cx="16.7" cy="4.55" r="1.15" fill="#e3b0f8" opacity=".5" />
          <circle cx="6.05" cy="4.25" r=".4" fill="#fff" opacity=".4" />
          <circle cx="11.05" cy="2.55" r=".48" fill="#fff" opacity=".42" />
          <circle cx="16.55" cy="4.25" r=".4" fill="#fff" opacity=".4" />
        </g>
        <circle cx="12" cy="14.3" r="8.3" fill="#6c2098" />
        <circle cx="12" cy="13.8" r="8.3" fill={fill} />
        <ellipse cx="12.15" cy="16.9" rx="5.15" ry="3.9" fill="#6c2098" opacity=".2" />
        <ellipse cx="12" cy="17.2" rx="4.35" ry="3.1" fill="#d39af0" opacity=".28" />
        <ellipse cx="8.5" cy="10.6" rx="3.3" ry="2.2" fill="#fff" opacity=".34" />
        <ellipse cx="16.5" cy="12" rx=".75" ry="3.1" fill="#fff" opacity=".15" transform="rotate(16 16.5 12)" />
        <ellipse cx="5.1" cy="17.85" rx="1.18" ry="1.02" fill="#6c2098" />
        <ellipse cx="5.1" cy="17.45" rx="1.18" ry="1.02" fill={fill} />
        <ellipse cx="18.9" cy="17.85" rx="1.18" ry="1.02" fill="#6c2098" />
        <ellipse cx="18.9" cy="17.45" rx="1.18" ry="1.02" fill={fill} />
        <ellipse cx="6.75" cy="15.9" rx="1.7" ry="1.05" fill="#ffb3c8" opacity=".8" />
        <ellipse cx="17.25" cy="15.9" rx="1.7" ry="1.05" fill="#ffb3c8" opacity=".8" />
        <path d="M7.2 13C8.45 14.7 10.55 14.7 11.55 13" fill="none" stroke="#23213a" strokeWidth="1.4" strokeLinecap="round" />
        <g className="wmux-mochi-eye wmux-mo8-eye">
          <ellipse cx="15.35" cy="13.15" rx="1.7" ry="2.05" fill="#23213a" />
          <ellipse cx="15.85" cy="12.35" rx=".85" ry=".9" fill="#fff" />
          <ellipse cx="14.78" cy="13.8" rx=".32" ry=".38" fill="#fff" />
        </g>
        <path d="M9.85 16.2C10.7 17.85 13.3 17.85 14.15 16.2C13.1 17.1 10.9 17.1 9.85 16.2Z" fill="#23213a" />
        <ellipse cx="12" cy="16.75" rx=".55" ry=".22" fill="#fff" opacity=".25" />
      </g>
    </>
  );
}

function MomoArt({ gid }: ArtProps): React.ReactElement {
  const fill = `url(#${gid})`;
  return (
    <>
      <defs>
        <radialGradient id={gid} cx="36%" cy="34%" r="72%">
          <stop offset="0%" stopColor="#e56bbb" />
          <stop offset="44%" stopColor="#c0359f" />
          <stop offset="100%" stopColor="#8e176e" />
        </radialGradient>
      </defs>
      <g className="wmux-mochi-body wmux-mo3-root">
        <ellipse cx="8.4" cy="22.15" rx="3" ry="1.65" fill="#8e176e" />
        <ellipse cx="15.6" cy="22.15" rx="3" ry="1.65" fill="#8e176e" />
        <ellipse cx="8.4" cy="21.55" rx="3" ry="1.65" fill={fill} />
        <ellipse cx="15.6" cy="21.55" rx="3" ry="1.65" fill={fill} />
        <ellipse cx="8.15" cy="21.2" rx="1.1" ry=".42" fill="#fff" opacity=".22" />
        <ellipse cx="15.35" cy="21.2" rx="1.1" ry=".42" fill="#fff" opacity=".22" />
        <g>
          <ellipse cx="7.35" cy="5.7" rx="2.35" ry="5.45" fill="#8e176e" transform="rotate(-12 7.35 5.7)" />
          <ellipse cx="7.35" cy="5.2" rx="2.35" ry="5.45" fill={fill} transform="rotate(-12 7.35 5.2)" />
          <ellipse cx="7.7" cy="5.55" rx="1.05" ry="3.05" fill="#ffb3c8" opacity=".55" transform="rotate(-12 7.7 5.55)" />
        </g>
        <g className="wmux-mochi-sig wmux-mo3-flop">
          <ellipse cx="17.55" cy="7.55" rx="4.7" ry="2.25" fill="#8e176e" transform="rotate(36 17.55 7.55)" />
          <ellipse cx="17.55" cy="7.05" rx="4.7" ry="2.25" fill={fill} transform="rotate(36 17.55 7.05)" />
          <ellipse cx="17.85" cy="7.15" rx="2.55" ry="1.05" fill="#ffb3c8" opacity=".55" transform="rotate(36 17.85 7.15)" />
        </g>
        <circle cx="12" cy="14.5" r="8.2" fill="#8e176e" />
        <circle cx="12" cy="14" r="8.2" fill={fill} />
        <ellipse cx="12.15" cy="17.15" rx="5.1" ry="3.9" fill="#8e176e" opacity=".2" />
        <ellipse cx="12" cy="17.45" rx="4.35" ry="3.1" fill="#f0a0d0" opacity=".28" />
        <ellipse cx="8.6" cy="11" rx="3.3" ry="2.2" fill="#fff" opacity=".34" />
        <ellipse cx="16.45" cy="12.2" rx=".75" ry="3.1" fill="#fff" opacity=".15" transform="rotate(18 16.45 12.2)" />
        <path d="M10.15 17.35C10.95 18.4 13.05 18.4 13.85 17.35C12.95 17.9 11.05 17.9 10.15 17.35Z" fill="#8e176e" opacity=".28" />
        <ellipse cx="5.15" cy="18.05" rx="1.2" ry="1.02" fill="#8e176e" />
        <ellipse cx="5.15" cy="17.65" rx="1.2" ry="1.02" fill={fill} />
        <ellipse cx="18.85" cy="18.05" rx="1.2" ry="1.02" fill="#8e176e" />
        <ellipse cx="18.85" cy="17.65" rx="1.2" ry="1.02" fill={fill} />
        <ellipse cx="6.9" cy="16.05" rx="1.7" ry="1.05" fill="#ffb3c8" opacity=".85" />
        <ellipse cx="17.1" cy="16.05" rx="1.7" ry="1.05" fill="#ffb3c8" opacity=".85" />
        <g className="wmux-mochi-eye wmux-mo3-eye">
          <ellipse cx="9.15" cy="13.35" rx="1.65" ry="2" fill="#23213a" />
          <ellipse cx="9.65" cy="12.55" rx=".85" ry=".9" fill="#fff" />
          <ellipse cx="8.62" cy="14" rx=".3" ry=".36" fill="#fff" />
        </g>
        <g className="wmux-mochi-eye wmux-mo3-eye">
          <ellipse cx="14.85" cy="13.35" rx="1.65" ry="2" fill="#23213a" />
          <ellipse cx="15.35" cy="12.55" rx=".85" ry=".9" fill="#fff" />
          <ellipse cx="14.32" cy="14" rx=".3" ry=".36" fill="#fff" />
        </g>
        <path d="M10 16.15C10.75 17.7 13.25 17.7 14 16.15C13 17 11 17 10 16.15Z" fill="#23213a" />
        <ellipse cx="12" cy="16.7" rx=".55" ry=".22" fill="#fff" opacity=".25" />
      </g>
    </>
  );
}

function PipArt({ gid }: ArtProps): React.ReactElement {
  const fill = `url(#${gid})`;
  return (
    <>
      <defs>
        <radialGradient id={gid} cx="36%" cy="30%" r="72%">
          <stop offset="0%" stopColor="#6ad8ec" />
          <stop offset="42%" stopColor="#0b8fb0" />
          <stop offset="100%" stopColor="#056379" />
        </radialGradient>
      </defs>
      <g className="wmux-mochi-body wmux-mo1-root">
        <ellipse cx="8.3" cy="22.05" rx="3.1" ry="1.7" fill="#055a6e" />
        <ellipse cx="15.7" cy="22.05" rx="3.1" ry="1.7" fill="#055a6e" />
        <ellipse cx="8.3" cy="21.5" rx="3.1" ry="1.7" fill={fill} />
        <ellipse cx="15.7" cy="21.5" rx="3.1" ry="1.7" fill={fill} />
        <ellipse cx="8.05" cy="21.15" rx="1.15" ry=".45" fill="#fff" opacity=".22" />
        <ellipse cx="15.45" cy="21.15" rx="1.15" ry=".45" fill="#fff" opacity=".22" />
        <ellipse cx="7.4" cy="21.55" rx=".4" ry=".28" fill="#055a6e" opacity=".35" />
        <ellipse cx="8.7" cy="21.7" rx=".4" ry=".28" fill="#055a6e" opacity=".35" />
        <ellipse cx="14.8" cy="21.55" rx=".4" ry=".28" fill="#055a6e" opacity=".35" />
        <ellipse cx="16.1" cy="21.7" rx=".4" ry=".28" fill="#055a6e" opacity=".35" />
        <g className="wmux-mochi-sig wmux-mo1-earL">
          <ellipse cx="6.15" cy="6.35" rx="2.85" ry="4.45" fill="#055a6e" transform="rotate(-18 6.15 6.35)" />
          <ellipse cx="6.15" cy="5.85" rx="2.85" ry="4.45" fill={fill} transform="rotate(-18 6.15 5.85)" />
          <ellipse cx="6.55" cy="6.2" rx="1.25" ry="2.5" fill="#ffb3c8" opacity=".55" transform="rotate(-18 6.55 6.2)" />
        </g>
        <g>
          <ellipse cx="17.85" cy="6.35" rx="2.85" ry="4.45" fill="#055a6e" transform="rotate(18 17.85 6.35)" />
          <ellipse cx="17.85" cy="5.85" rx="2.85" ry="4.45" fill={fill} transform="rotate(18 17.85 5.85)" />
          <ellipse cx="17.45" cy="6.2" rx="1.25" ry="2.5" fill="#ffb3c8" opacity=".55" transform="rotate(18 17.45 6.2)" />
        </g>
        <circle cx="12" cy="13.7" r="8.5" fill="#055a6e" />
        <circle cx="12" cy="13.2" r="8.5" fill={fill} />
        <ellipse cx="12.2" cy="16.55" rx="5.4" ry="4.15" fill="#056379" opacity=".2" />
        <ellipse cx="12" cy="16.95" rx="4.55" ry="3.25" fill="#8fe4f2" opacity=".3" />
        <ellipse cx="8.4" cy="10" rx="3.5" ry="2.3" fill="#fff" opacity=".34" />
        <ellipse cx="16.55" cy="11.35" rx=".8" ry="3.35" fill="#fff" opacity=".16" transform="rotate(18 16.55 11.35)" />
        <circle cx="10.3" cy="16.55" r=".38" fill="#056379" opacity=".38" />
        <circle cx="12" cy="17.15" r=".38" fill="#056379" opacity=".38" />
        <circle cx="13.7" cy="16.55" r=".38" fill="#056379" opacity=".38" />
        <ellipse cx="4.95" cy="17.35" rx="1.25" ry="1.05" fill="#055a6e" />
        <ellipse cx="4.95" cy="16.95" rx="1.25" ry="1.05" fill={fill} />
        <ellipse cx="19.05" cy="17.35" rx="1.25" ry="1.05" fill="#055a6e" />
        <ellipse cx="19.05" cy="16.95" rx="1.25" ry="1.05" fill={fill} />
        <ellipse cx="6.7" cy="15.35" rx="1.75" ry="1.05" fill="#ffb3c8" opacity=".8" />
        <ellipse cx="17.3" cy="15.35" rx="1.75" ry="1.05" fill="#ffb3c8" opacity=".8" />
        <g className="wmux-mochi-eye wmux-mo1-eye">
          <ellipse cx="9.05" cy="12.55" rx="1.7" ry="2.05" fill="#23213a" />
          <ellipse cx="9.55" cy="11.75" rx=".85" ry=".9" fill="#fff" />
          <ellipse cx="8.5" cy="13.2" rx=".32" ry=".38" fill="#fff" />
        </g>
        <g className="wmux-mochi-eye wmux-mo1-eye">
          <ellipse cx="14.95" cy="12.55" rx="1.7" ry="2.05" fill="#23213a" />
          <ellipse cx="15.45" cy="11.75" rx=".85" ry=".9" fill="#fff" />
          <ellipse cx="14.4" cy="13.2" rx=".32" ry=".38" fill="#fff" />
        </g>
        <path d="M9.7 15.55C10.55 17.4 13.45 17.4 14.3 15.55C13.2 16.5 10.8 16.5 9.7 15.55Z" fill="#23213a" />
        <ellipse cx="12" cy="16.12" rx=".65" ry=".26" fill="#fff" opacity=".28" />
      </g>
    </>
  );
}

function KoaArt({ gid }: ArtProps): React.ReactElement {
  const fill = `url(#${gid})`;
  return (
    <>
      <defs>
        <radialGradient id={gid} cx="36%" cy="30%" r="72%">
          <stop offset="0%" stopColor="#6eb7ee" />
          <stop offset="44%" stopColor="#2a8fd8" />
          <stop offset="100%" stopColor="#186496" />
        </radialGradient>
      </defs>
      <g className="wmux-mochi-body wmux-mo7-root">
        <ellipse cx="8.35" cy="22.05" rx="3.05" ry="1.65" fill="#186496" />
        <ellipse cx="15.65" cy="22.05" rx="3.05" ry="1.65" fill="#186496" />
        <ellipse cx="8.35" cy="21.5" rx="3.05" ry="1.65" fill={fill} />
        <ellipse cx="15.65" cy="21.5" rx="3.05" ry="1.65" fill={fill} />
        <ellipse cx="8.1" cy="21.15" rx="1.1" ry=".42" fill="#fff" opacity=".22" />
        <ellipse cx="15.4" cy="21.15" rx="1.1" ry=".42" fill="#fff" opacity=".22" />
        <g className="wmux-mochi-sig wmux-mo7-earL">
          <ellipse cx="3.55" cy="12.15" rx="3.35" ry="4.05" fill="#186496" />
          <ellipse cx="3.55" cy="11.65" rx="3.35" ry="4.05" fill={fill} />
          <ellipse cx="2.4" cy="11.45" rx="1.55" ry="2.2" fill="#ffb3c8" opacity=".5" />
          <ellipse cx="2.15" cy="10.35" rx=".55" ry=".85" fill="#fff" opacity=".22" />
        </g>
        <g className="wmux-mochi-sig wmux-mo7-earR">
          <ellipse cx="20.45" cy="12.15" rx="3.35" ry="4.05" fill="#186496" />
          <ellipse cx="20.45" cy="11.65" rx="3.35" ry="4.05" fill={fill} />
          <ellipse cx="21.6" cy="11.45" rx="1.55" ry="2.2" fill="#ffb3c8" opacity=".5" />
          <ellipse cx="21.85" cy="10.35" rx=".55" ry=".85" fill="#fff" opacity=".2" />
        </g>
        <circle cx="12" cy="13.7" r="8.4" fill="#186496" />
        <circle cx="12" cy="13.2" r="8.4" fill={fill} />
        <ellipse cx="12.15" cy="16.5" rx="5.2" ry="4" fill="#186496" opacity=".2" />
        <ellipse cx="12" cy="16.85" rx="4.4" ry="3.2" fill="#8ecaf2" opacity=".28" />
        <ellipse cx="8.5" cy="10" rx="3.4" ry="2.25" fill="#fff" opacity=".34" />
        <ellipse cx="16.55" cy="11.2" rx=".75" ry="3.2" fill="#fff" opacity=".15" transform="rotate(16 16.55 11.2)" />
        <circle cx="10.55" cy="16.7" r=".32" fill="#186496" opacity=".4" />
        <circle cx="13.55" cy="16.7" r=".32" fill="#186496" opacity=".4" />
        <ellipse cx="5.15" cy="17.45" rx="1.15" ry="1" fill="#186496" />
        <ellipse cx="5.15" cy="17.05" rx="1.15" ry="1" fill={fill} />
        <ellipse cx="18.85" cy="17.45" rx="1.15" ry="1" fill="#186496" />
        <ellipse cx="18.85" cy="17.05" rx="1.15" ry="1" fill={fill} />
        <ellipse cx="6.7" cy="15.4" rx="1.7" ry="1.05" fill="#ffb3c8" opacity=".8" />
        <ellipse cx="17.3" cy="15.4" rx="1.7" ry="1.05" fill="#ffb3c8" opacity=".8" />
        <g className="wmux-mochi-eye wmux-mo7-eye">
          <ellipse cx="10.15" cy="12.5" rx="1.7" ry="2.05" fill="#23213a" />
          <ellipse cx="10.75" cy="11.7" rx=".85" ry=".9" fill="#fff" />
          <ellipse cx="9.6" cy="13.15" rx=".32" ry=".38" fill="#fff" />
        </g>
        <g className="wmux-mochi-eye wmux-mo7-eye">
          <ellipse cx="16.05" cy="12.5" rx="1.7" ry="2.05" fill="#23213a" />
          <ellipse cx="16.65" cy="11.7" rx=".85" ry=".9" fill="#fff" />
          <ellipse cx="15.5" cy="13.15" rx=".32" ry=".38" fill="#fff" />
        </g>
        <path d="M10.6 15.55C11.45 17.3 14.15 17.3 15 15.55C13.95 16.5 11.65 16.5 10.6 15.55Z" fill="#23213a" />
        <ellipse cx="12.8" cy="16.15" rx=".6" ry=".24" fill="#fff" opacity=".25" />
      </g>
    </>
  );
}

function NubArt({ gid }: ArtProps): React.ReactElement {
  const fill = `url(#${gid})`;
  return (
    <>
      <defs>
        <radialGradient id={gid} cx="36%" cy="32%" r="72%">
          <stop offset="0%" stopColor="#9aabc4" />
          <stop offset="44%" stopColor="#5a6b8c" />
          <stop offset="100%" stopColor="#3a4760" />
        </radialGradient>
      </defs>
      <g className="wmux-mochi-body wmux-mo5-root">
        <g className="wmux-mochi-sig wmux-mo5-nubL">
          <ellipse cx="2.95" cy="14.7" rx="2.05" ry="2.55" fill="#3a4760" />
          <ellipse cx="2.95" cy="14.2" rx="2.05" ry="2.55" fill={fill} />
          <ellipse cx="2.55" cy="13.7" rx=".7" ry="1.05" fill="#fff" opacity=".2" />
        </g>
        <g className="wmux-mochi-sig wmux-mo5-nubR">
          <ellipse cx="21.05" cy="14.7" rx="2.05" ry="2.55" fill="#3a4760" />
          <ellipse cx="21.05" cy="14.2" rx="2.05" ry="2.55" fill={fill} />
          <ellipse cx="21.45" cy="13.7" rx=".7" ry="1.05" fill="#fff" opacity=".18" />
        </g>
        <ellipse cx="8.2" cy="22.05" rx="3.2" ry="1.7" fill="#3a4760" />
        <ellipse cx="15.8" cy="22.05" rx="3.2" ry="1.7" fill="#3a4760" />
        <ellipse cx="8.2" cy="21.5" rx="3.2" ry="1.7" fill={fill} />
        <ellipse cx="15.8" cy="21.5" rx="3.2" ry="1.7" fill={fill} />
        <ellipse cx="7.9" cy="21.15" rx="1.15" ry=".45" fill="#fff" opacity=".2" />
        <ellipse cx="15.5" cy="21.15" rx="1.15" ry=".45" fill="#fff" opacity=".2" />
        <ellipse cx="12" cy="13.7" rx="10.15" ry="8.35" fill="#3a4760" />
        <ellipse cx="12" cy="13.2" rx="10.15" ry="8.35" fill={fill} />
        <ellipse cx="12.2" cy="16.4" rx="6.6" ry="4.1" fill="#3a4760" opacity=".22" />
        <ellipse cx="12" cy="16.7" rx="5.6" ry="3.3" fill="#c5d0e0" opacity=".26" />
        <ellipse cx="8.2" cy="10.2" rx="3.8" ry="2.3" fill="#fff" opacity=".32" />
        <ellipse cx="17.6" cy="11.5" rx=".9" ry="3.2" fill="#fff" opacity=".14" transform="rotate(14 17.6 11.5)" />
        <circle cx="9.2" cy="16.5" r=".32" fill="#3a4760" opacity=".4" />
        <circle cx="11.1" cy="17.35" r=".28" fill="#3a4760" opacity=".35" />
        <circle cx="13.4" cy="17.15" r=".3" fill="#3a4760" opacity=".38" />
        <circle cx="15.3" cy="16.4" r=".26" fill="#3a4760" opacity=".32" />
        <ellipse cx="5.7" cy="15.4" rx="1.85" ry="1.15" fill="#ffb3c8" opacity=".8" />
        <ellipse cx="18.3" cy="15.4" rx="1.85" ry="1.15" fill="#ffb3c8" opacity=".8" />
        <g className="wmux-mochi-eye wmux-mo5-eye">
          <path d="M7.15 12.55C8.55 14.55 10.7 14.55 12.05 12.55" fill="none" stroke="#23213a" strokeWidth="1.4" strokeLinecap="round" />
          <path d="M11.95 12.55C13.35 14.55 15.5 14.55 16.85 12.55" fill="none" stroke="#23213a" strokeWidth="1.4" strokeLinecap="round" />
        </g>
        <path d="M10.3 16.15C11.1 17.45 12.9 17.45 13.7 16.15C12.7 16.95 11.3 16.95 10.3 16.15Z" fill="#23213a" />
        <ellipse cx="12" cy="16.7" rx=".55" ry=".22" fill="#fff" opacity=".22" />
      </g>
    </>
  );
}

/** The characters, in BOT_IDENTITY_HUES order. */
export const MOCHI_CHARACTERS: readonly MochiCharacter[] = [
  { name: 'Loaf', body: '#3d6ff5', Art: LoafArt },
  { name: 'Nova', body: '#5b5bd6', Art: NovaArt },
  { name: 'Plume', body: '#7c4ddb', Art: PlumeArt },
  { name: 'Wink', body: '#9d3fd1', Art: WinkArt },
  { name: 'Momo', body: '#c0359f', Art: MomoArt },
  { name: 'Pip', body: '#0b8fb0', Art: PipArt },
  { name: 'Koa', body: '#2a8fd8', Art: KoaArt },
  { name: 'Nub', body: '#5a6b8c', Art: NubArt },
];
