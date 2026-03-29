import { useState, useEffect, useRef, useCallback } from 'react';
import type { Theme } from '../theme';
import { useTheme } from '../theme';

// ==========================================
// Filen API types
// ==========================================
interface FilenAuth {
  apiKey: string;
  email: string;
}

interface FilenItem {
  type: 'folder' | 'file';
  name: string;
  uuid: string;
  size?: number;
  key?: string;
}

interface NavEntry {
  uuid: string;
  name: string;
}

const FILEN_API = 'https://gateway.filen.io';

// ==========================================
// Crypto helpers — matches Filen SDK v002
// ==========================================
async function sha512(input: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-512', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function deriveKeyFromPassword(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 200000, hash: 'SHA-512' }, key, 512
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function generatePasswordAndMasterKey(rawPassword: string, authVersion: number, salt: string) {
  if (authVersion === 1) {
    const h = await sha512(rawPassword);
    return { derivedPassword: h, derivedMasterKeys: h };
  }
  const dk = await deriveKeyFromPassword(rawPassword, salt);
  return {
    derivedMasterKeys: dk.substring(0, dk.length / 2),
    derivedPassword: await sha512(dk.substring(dk.length / 2)),
  };
}

async function decryptMetadata(metadata: string, key: string): Promise<string | null> {
  try {
    if (!metadata || metadata.length < 16 || metadata.slice(0, 3) !== '002') return null;
    const enc = new TextEncoder();
    const pbk = await crypto.subtle.importKey('raw', enc.encode(key), 'PBKDF2', false, ['deriveBits']);
    const keyBits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode(key), iterations: 1, hash: 'SHA-512' }, pbk, 256
    );
    const aesKey = await crypto.subtle.importKey('raw', keyBits, 'AES-GCM', false, ['decrypt']);
    const dec = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: enc.encode(metadata.slice(3, 15)) }, aesKey,
      Uint8Array.from(atob(metadata.slice(15)), c => c.charCodeAt(0))
    );
    return new TextDecoder().decode(dec);
  } catch {
    return null;
  }
}

// ==========================================
// API helper
// ==========================================
async function filenApi(endpoint: string, data: Record<string, unknown>, apiKey?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(`${FILEN_API}${endpoint}`, {
    method: 'POST', headers, body: JSON.stringify(data),
  });
  return res.json();
}

// ==========================================
// File helpers
// ==========================================
function fileIcon(name: string, isFolder: boolean): string {
  if (isFolder) return '\u{1F4C1}';
  const ext = name.toLowerCase().split('.').pop() || '';
  const map: Record<string, string> = {
    pdf: '\u{1F4C4}', doc: '\u{1F4C3}', docx: '\u{1F4C3}', xls: '\u{1F4CA}', xlsx: '\u{1F4CA}',
    jpg: '\u{1F5BC}', jpeg: '\u{1F5BC}', png: '\u{1F5BC}', gif: '\u{1F5BC}', webp: '\u{1F5BC}', svg: '\u{1F5BC}',
    mp4: '\u{1F3AC}', mov: '\u{1F3AC}', mp3: '\u{1F3B5}', wav: '\u{1F3B5}',
    zip: '\u{1F5DC}', rar: '\u{1F5DC}', gz: '\u{1F5DC}', tar: '\u{1F5DC}',
    txt: '\u{1F4DD}', md: '\u{1F4DD}', json: '\u{1F4DD}', csv: '\u{1F4DD}',
    js: '\u26A1', ts: '\u26A1', py: '\u{1F40D}', html: '\u{1F310}', css: '\u{1F3A8}',
  };
  return map[ext] || '\u{1F4C4}';
}

function fmtSize(b: number): string {
  if (!b) return '';
  const k = 1024;
  const s = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return parseFloat((b / Math.pow(k, i)).toFixed(1)) + ' ' + s[i];
}

// ==========================================
// Component
// ==========================================
export function FilenStorageWidget() {
  const { theme } = useTheme();
  const s = widgetStyles(theme);

  // Auth state
  const [auth, setAuth] = useState<FilenAuth | null>(null);
  const [masterKeys, setMasterKeys] = useState<string[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [twofa, setTwofa] = useState('');
  const [status, setStatus] = useState<{ msg: string; type: 'error' | 'info' | 'success' } | null>(null);
  const [connecting, setConnecting] = useState(false);

  // Browser state
  const [expanded, setExpanded] = useState(false);
  const [baseFolderUuid, setBaseFolderUuid] = useState('');
  const [currentFolderUuid, setCurrentFolderUuid] = useState('');
  const [navStack, setNavStack] = useState<NavEntry[]>([]);
  const [items, setItems] = useState<FilenItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [browseError, setBrowseError] = useState('');

  // Share state
  const [shareToast, setShareToast] = useState<{ name: string; url: string } | null>(null);
  const [sharingUuid, setSharingUuid] = useState<string | null>(null);

  const masterKeysRef = useRef(masterKeys);
  masterKeysRef.current = masterKeys;
  const authRef = useRef(auth);
  authRef.current = auth;

  const tryDecrypt = useCallback(async (metadata: string): Promise<string | null> => {
    for (const k of masterKeysRef.current) {
      const r = await decryptMetadata(metadata, k);
      if (r) return r;
    }
    return null;
  }, []);

  // Load folder contents
  const loadFolder = useCallback(async (uuid: string) => {
    if (!authRef.current) return;
    setLoading(true);
    setBrowseError('');
    try {
      const res = await filenApi('/v3/dir/content', { uuid }, authRef.current.apiKey);
      if (!res.status) {
        setBrowseError(res.message || 'Failed to load folder');
        setItems([]);
        return;
      }
      const parsed: FilenItem[] = [];
      for (const f of (res.data.folders || [])) {
        let name = f.name;
        const dec = await tryDecrypt(f.name);
        if (dec) { try { name = JSON.parse(dec).name || dec; } catch { name = dec; } }
        parsed.push({ type: 'folder', name, uuid: f.uuid });
      }
      for (const f of (res.data.uploads || [])) {
        let name = f.name || '?', size = f.size || 0, fileKey = '';
        const dec = await tryDecrypt(f.metadata);
        if (dec) { try { const p = JSON.parse(dec); name = p.name || name; size = p.size || size; fileKey = p.key || ''; } catch { name = dec; } }
        parsed.push({ type: 'file', name, uuid: f.uuid, size, key: fileKey });
      }
      parsed.sort((a, b) => (a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name)));
      setItems(parsed);
    } catch (e: any) {
      setBrowseError(e.message);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [tryDecrypt]);

  // Navigate into folder
  function enterFolder(folder: FilenItem) {
    setNavStack(prev => [...prev, { uuid: currentFolderUuid, name: getCurrentName() }]);
    setCurrentFolderUuid(folder.uuid);
    loadFolder(folder.uuid);
  }

  function getCurrentName(): string {
    if (navStack.length === 0) return 'My Drive';
    return navStack[navStack.length - 1].name;
  }

  function navigateTo(idx: number) {
    if (idx === 0) {
      setNavStack([]);
      setCurrentFolderUuid(baseFolderUuid);
      loadFolder(baseFolderUuid);
    } else if (idx <= navStack.length) {
      const target = navStack[idx - 1];
      setNavStack(prev => prev.slice(0, idx - 1));
      setCurrentFolderUuid(target.uuid);
      loadFolder(target.uuid);
    }
  }

  // Share link
  async function createShareLink(fileUuid: string, fileName: string, fileKey: string) {
    if (!auth) return;
    setSharingUuid(fileUuid);
    try {
      const statusRes = await filenApi('/v3/file/link/status', { uuid: fileUuid }, auth.apiKey);
      let linkUuid: string;
      if (statusRes.status && statusRes.data?.enabled && statusRes.data?.uuid) {
        linkUuid = statusRes.data.uuid;
      } else {
        linkUuid = statusRes.data?.uuid || crypto.randomUUID();
        const editRes = await filenApi('/v3/file/link/edit', {
          uuid: fileUuid, fileUUID: fileUuid, expiration: 'never',
          password: 'empty', downloadBtn: true, type: 'enable', linkUUID: linkUuid,
        }, auth.apiKey);
        if (!editRes.status) throw new Error(editRes.message || 'Failed to create share link');
      }
      const shareUrl = `https://filen.io/f/${linkUuid}#${fileKey}`;
      setShareToast({ name: fileName, url: shareUrl });
    } catch (e: any) {
      setStatus({ msg: 'Share failed: ' + e.message, type: 'error' });
    } finally {
      setSharingUuid(null);
    }
  }

  // Connect
  async function handleConnect() {
    if (!email || !password) { setStatus({ msg: 'Email and password required', type: 'error' }); return; }
    setConnecting(true);
    setStatus({ msg: 'Fetching auth info...', type: 'info' });
    try {
      const info = await filenApi('/v3/auth/info', { email });
      if (!info.status) { setStatus({ msg: info.message || 'Auth info failed', type: 'error' }); return; }

      setStatus({ msg: 'Deriving encryption keys...', type: 'info' });
      const { derivedPassword, derivedMasterKeys } = await generatePasswordAndMasterKey(
        password, info.data.authVersion, info.data.salt
      );

      setStatus({ msg: 'Authenticating...', type: 'info' });
      const login = await filenApi('/v3/login', {
        email, password: derivedPassword,
        twoFactorCode: twofa || 'XXXXXX',
        authVersion: info.data.authVersion,
      });
      if (!login.status) { setStatus({ msg: login.message || 'Login failed', type: 'error' }); return; }

      const newAuth: FilenAuth = { apiKey: login.data.apiKey, email };
      const newKeys = [derivedMasterKeys];
      setAuth(newAuth);
      setMasterKeys(newKeys);
      authRef.current = newAuth;
      masterKeysRef.current = newKeys;

      const base = await filenApi('/v3/user/baseFolder', {}, login.data.apiKey);
      if (base.status) {
        setBaseFolderUuid(base.data.uuid);
        setCurrentFolderUuid(base.data.uuid);
        setStatus({ msg: 'Connected', type: 'success' });
        // Load root folder
        setExpanded(true);
        setLoading(true);
        const res = await filenApi('/v3/dir/content', { uuid: base.data.uuid }, newAuth.apiKey);
        if (res.status) {
          const parsed: FilenItem[] = [];
          for (const f of (res.data.folders || [])) {
            let name = f.name;
            const dec = await decryptMetadata(f.name, newKeys[0]);
            if (dec) { try { name = JSON.parse(dec).name || dec; } catch { name = dec; } }
            parsed.push({ type: 'folder', name, uuid: f.uuid });
          }
          for (const f of (res.data.uploads || [])) {
            let name = f.name || '?', size = f.size || 0, fileKey = '';
            const dec = await decryptMetadata(f.metadata, newKeys[0]);
            if (dec) { try { const p = JSON.parse(dec); name = p.name || name; size = p.size || size; fileKey = p.key || ''; } catch { name = dec; } }
            parsed.push({ type: 'file', name, uuid: f.uuid, size, key: fileKey });
          }
          parsed.sort((a, b) => (a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name)));
          setItems(parsed);
        }
        setLoading(false);
      }
    } catch (e: any) {
      setStatus({ msg: e.message, type: 'error' });
    } finally {
      setConnecting(false);
    }
  }

  function handleDisconnect() {
    setAuth(null);
    setMasterKeys([]);
    setBaseFolderUuid('');
    setCurrentFolderUuid('');
    setNavStack([]);
    setItems([]);
    setExpanded(false);
    setPassword('');
    setTwofa('');
    setStatus(null);
    setShareToast(null);
  }

  // Breadcrumb parts
  const breadcrumbParts = navStack.map(n => n.name);
  if (navStack.length > 0 || currentFolderUuid !== baseFolderUuid) {
    // add current folder name if we've navigated
  }

  // ---- RENDER ----

  // Collapsed setup button (not connected)
  if (!auth && !expanded) {
    return (
      <button style={s.setupBtn} onClick={() => setExpanded(true)}>
        <div style={s.setupIcon}>
          <CloudIcon />
        </div>
        <div style={{ flex: 1, textAlign: 'left' as const }}>
          <div style={s.setupTitle}>Set up extra data storage</div>
          <div style={s.setupSub}>End-to-end encrypted &middot; free &middot; powered by Filen</div>
        </div>
        <span style={s.setupArrow}>&rsaquo;</span>
      </button>
    );
  }

  // Collapsed connected button
  if (auth && !expanded) {
    return (
      <button style={s.setupBtn} onClick={() => setExpanded(true)}>
        <div style={{ ...s.setupIcon, background: theme.successBg, border: `1px solid ${theme.successBorder}` }}>
          <CloudIcon color={theme.success} />
        </div>
        <div style={{ flex: 1, textAlign: 'left' as const }}>
          <div style={s.setupTitle}>Filen Storage</div>
          <div style={s.setupSub}>Connected as {auth.email}</div>
        </div>
        <span style={s.setupArrow}>&rsaquo;</span>
      </button>
    );
  }

  return (
    <div style={s.widget}>
      {/* Header */}
      <div style={s.header}>
        <div style={s.headerLeft}>
          <div style={{ ...s.dot, background: auth ? theme.success : theme.textMuted }} />
          <CloudIcon size={14} color={theme.textSecondary} />
          <span style={s.headerTitle}>{auth ? `Filen \u00B7 ${auth.email}` : 'Filen Storage'}</span>
        </div>
        <button style={s.headerBtn} onClick={() => setExpanded(false)} title="Minimize">&minus;</button>
      </div>

      {/* Login panel */}
      {!auth && (
        <div style={s.loginPanel}>
          <div style={s.explainer}>
            <strong style={{ color: theme.text }}>Filen</strong> is a free cloud storage service with zero-knowledge
            encryption. Your files are encrypted on your device before they leave
            it — Filen's servers never see your data.{' '}
            <a href="https://github.com/FilenCloudDienste" target="_blank" rel="noreferrer" style={{ color: theme.accent, textDecoration: 'none' }}>
              Fully open source
            </a>.
            <div style={s.tagRow}>
              <span style={s.tag}>End-to-end encrypted</span>
              <span style={s.tag}>German privacy law</span>
              <span style={s.tag}>10 GB free</span>
              <span style={s.tag}>Open source</span>
            </div>
          </div>

          <div style={s.field}>
            <label style={s.label}>Email</label>
            <input style={s.input} type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="you@email.com" onKeyDown={e => e.key === 'Enter' && handleConnect()} />
          </div>
          <div style={s.field}>
            <label style={s.label}>Password</label>
            <input style={s.input} type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Password" onKeyDown={e => e.key === 'Enter' && handleConnect()} />
          </div>
          <div style={s.field}>
            <label style={s.label}>2FA code (optional)</label>
            <input style={s.input} type="text" value={twofa} onChange={e => setTwofa(e.target.value)}
              placeholder="123456" onKeyDown={e => e.key === 'Enter' && handleConnect()} />
          </div>

          {status && (
            <div style={{
              ...s.statusMsg,
              ...(status.type === 'error' ? s.statusError : status.type === 'success' ? s.statusSuccess : s.statusInfo),
            }}>
              {status.msg}
            </div>
          )}

          <button style={s.connectBtn} onClick={handleConnect} disabled={connecting}>
            <CloudIcon size={14} />
            {connecting ? 'Connecting...' : 'Connect to Filen'}
          </button>

          <div style={s.footer}>
            No account?{' '}
            <a href="https://filen.io/register" target="_blank" rel="noreferrer" style={{ color: theme.accent, textDecoration: 'none' }}>
              Sign up free at filen.io
            </a>{' '}
            — takes 30 seconds
          </div>
        </div>
      )}

      {/* File browser */}
      {auth && (
        <div style={s.browser}>
          {/* Toolbar */}
          <div style={s.toolbar}>
            <button style={{ ...s.toolBtn, color: theme.danger, borderColor: theme.dangerBorder }}
              onClick={handleDisconnect}>
              Disconnect
            </button>
          </div>

          {/* Breadcrumb */}
          <div style={s.breadcrumbBar}>
            <span style={{ ...s.bcItem, ...(navStack.length === 0 ? s.bcCurrent : {}) }}
              onClick={() => navigateTo(0)}>My Drive</span>
            {navStack.map((n, i) => (
              <span key={i}>
                <span style={s.bcSep}>&rsaquo;</span>
                <span style={{ ...s.bcItem, ...(i === navStack.length - 1 ? s.bcCurrent : {}) }}
                  onClick={() => navigateTo(i + 1)}>{n.name}</span>
              </span>
            ))}
          </div>

          {/* File list */}
          <div style={s.fileList}>
            {loading && (
              <div style={s.emptyFolder}>Loading...</div>
            )}
            {!loading && browseError && (
              <div style={s.emptyFolder}>Error: {browseError}</div>
            )}
            {!loading && !browseError && items.length === 0 && (
              <div style={s.emptyFolder}>Empty folder</div>
            )}
            {!loading && items.map(item => (
              <div key={item.uuid} style={s.fileRow}
                onClick={() => item.type === 'folder' ? enterFolder(item) : undefined}
                onMouseEnter={e => (e.currentTarget.style.background = theme.bgHover)}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <span style={s.fIcon}>{fileIcon(item.name, item.type === 'folder')}</span>
                <span style={s.fName}>{item.name}</span>
                <span style={s.fSize}>{item.type === 'file' ? fmtSize(item.size || 0) : ''}</span>
                {item.type === 'file' && (
                  <button style={s.shareBtn}
                    onClick={e => { e.stopPropagation(); createShareLink(item.uuid, item.name, item.key || ''); }}>
                    {sharingUuid === item.uuid ? '...' : 'Share'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Share toast */}
      {shareToast && (
        <div style={s.shareToastBox}>
          <div style={s.shareToastHeader}>
            <span>Link: {shareToast.name}</span>
            <button style={s.shareClose} onClick={() => setShareToast(null)}>&times;</button>
          </div>
          <div style={s.shareToastLink}>
            <input style={s.shareLinkInput} value={shareToast.url} readOnly
              onClick={e => (e.target as HTMLInputElement).select()} />
            <button style={s.shareCopyBtn} onClick={() => {
              navigator.clipboard.writeText(shareToast.url).catch(() => {});
            }}>Copy</button>
          </div>
          <div style={s.shareNote}>Link includes decryption key — anyone with it can read the file</div>
        </div>
      )}
    </div>
  );
}

function CloudIcon({ size = 18, color = '#fff' }: { size?: number; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size}>
      <path fill={color} d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/>
    </svg>
  );
}

function widgetStyles(t: Theme): Record<string, React.CSSProperties> {
  const mono = "'JetBrains Mono', monospace";
  return {
    setupBtn: {
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 16px', background: t.bgCard, color: t.text,
      border: `1px solid ${t.border}`, borderRadius: 8,
      cursor: 'pointer', fontSize: 13, fontWeight: 500, width: '100%',
      fontFamily: mono, transition: 'all 0.15s',
    },
    setupIcon: {
      width: 32, height: 32, background: t.bgMuted, borderRadius: 6,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, padding: 5, border: `1px solid ${t.border}`,
    },
    setupTitle: { fontWeight: 600, marginBottom: 2, fontSize: 12 },
    setupSub: { fontSize: 10, color: t.textMuted },
    setupArrow: { color: t.textMuted, fontSize: 18 },

    widget: {
      background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 8,
      overflow: 'hidden', display: 'flex', flexDirection: 'column' as const,
      maxHeight: 520,
    },
    header: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 14px', background: t.bg, borderBottom: `1px solid ${t.border}`,
    },
    headerLeft: {
      display: 'flex', alignItems: 'center', gap: 8,
      fontFamily: mono, fontSize: 12, fontWeight: 600, color: t.text,
    },
    dot: { width: 6, height: 6, borderRadius: '50%' },
    headerTitle: { fontFamily: mono, fontSize: 12, fontWeight: 600, color: t.text },
    headerBtn: {
      background: 'transparent', border: `1px solid ${t.border}`, color: t.textMuted,
      padding: '2px 8px', borderRadius: 4, cursor: 'pointer', fontFamily: mono, fontSize: 12,
    },

    loginPanel: { padding: '16px 14px', display: 'flex', flexDirection: 'column' as const, gap: 12 },
    explainer: {
      padding: '12px 14px', background: t.accentBg,
      border: `1px solid ${t.accentBorder}`, borderRadius: 6,
      fontFamily: mono, fontSize: 11, lineHeight: 1.6, color: t.textSecondary,
    },
    tagRow: { marginTop: 8, display: 'flex', flexWrap: 'wrap' as const, gap: 5 },
    tag: {
      background: t.accentBg, color: t.accent,
      padding: '2px 7px', borderRadius: 3, fontSize: 10, fontWeight: 500,
      fontFamily: mono, border: `1px solid ${t.accentBorder}`,
    },
    field: { display: 'flex', flexDirection: 'column' as const, gap: 4 },
    label: {
      fontFamily: mono, fontSize: 9, fontWeight: 600, color: t.textMuted,
      textTransform: 'uppercase' as const, letterSpacing: '0.5px',
    },
    input: {
      padding: '8px 10px', background: t.bg, border: `1px solid ${t.border}`,
      borderRadius: 4, color: t.text, fontFamily: mono, fontSize: 12, outline: 'none',
    },
    statusMsg: {
      padding: '8px 10px', borderRadius: 4, fontFamily: mono, fontSize: 11,
    },
    statusError: { background: t.dangerBg, color: t.dangerText, border: `1px solid ${t.dangerBorder}` },
    statusInfo: { background: t.accentBg, color: t.accent, border: `1px solid ${t.accentBorder}` },
    statusSuccess: { background: t.successBg, color: t.successText, border: `1px solid ${t.successBorder}` },
    connectBtn: {
      padding: '10px', background: t.accent, color: '#fff', border: 'none',
      borderRadius: 6, fontFamily: mono, fontSize: 12, fontWeight: 600,
      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    },
    footer: { textAlign: 'center' as const, fontFamily: mono, fontSize: 10, color: t.textMuted },

    browser: { display: 'flex', flexDirection: 'column' as const, flex: 1, minHeight: 0 },
    toolbar: {
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 14px', borderBottom: `1px solid ${t.border}`,
      justifyContent: 'flex-end',
    },
    toolBtn: {
      background: 'transparent', border: `1px solid ${t.border}`, color: t.text,
      padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
      fontFamily: mono, fontSize: 10, fontWeight: 600,
    },
    breadcrumbBar: {
      display: 'flex', alignItems: 'center', gap: 4, padding: '6px 14px',
      fontFamily: mono, fontSize: 11, color: t.textMuted,
      borderBottom: `1px solid ${t.borderLight}`, overflowX: 'auto' as const,
    },
    bcItem: {
      color: t.textSecondary, cursor: 'pointer', padding: '2px 5px', borderRadius: 3,
    },
    bcCurrent: { color: t.accent, fontWeight: 600 },
    bcSep: { color: t.textMuted },

    fileList: {
      flex: 1, overflowY: 'auto' as const, padding: 6,
    },
    fileRow: {
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 10px', borderRadius: 4, cursor: 'pointer',
      transition: 'background 0.1s',
    },
    fIcon: { fontSize: 16, flexShrink: 0 },
    fName: {
      flex: 1, fontFamily: mono, fontSize: 12, color: t.text,
      whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis',
    },
    fSize: { fontFamily: mono, fontSize: 10, color: t.textMuted, flexShrink: 0 },
    shareBtn: {
      flexShrink: 0, background: 'transparent', border: `1px solid ${t.border}`,
      color: t.textSecondary, padding: '2px 7px', borderRadius: 3, cursor: 'pointer',
      fontFamily: mono, fontSize: 10,
    },
    emptyFolder: {
      textAlign: 'center' as const, padding: '30px 16px', color: t.textMuted,
      fontFamily: mono, fontSize: 12,
    },

    shareToastBox: {
      padding: '10px 14px', borderTop: `1px solid ${t.accentBorder}`,
      background: t.accentBg, display: 'flex', flexDirection: 'column' as const, gap: 6,
    },
    shareToastHeader: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      fontFamily: mono, fontSize: 11, fontWeight: 600, color: t.text,
    },
    shareClose: {
      background: 'none', border: 'none', color: t.textMuted, cursor: 'pointer',
      fontSize: 14, padding: '0 2px', fontFamily: mono,
    },
    shareToastLink: { display: 'flex', gap: 6, alignItems: 'center' },
    shareLinkInput: {
      flex: 1, background: t.bg, border: `1px solid ${t.border}`, color: t.accent,
      padding: '6px 8px', borderRadius: 4, fontFamily: mono, fontSize: 10,
    },
    shareCopyBtn: {
      background: t.accent, border: 'none', color: '#fff', padding: '6px 12px',
      borderRadius: 4, cursor: 'pointer', fontFamily: mono, fontSize: 10, fontWeight: 600,
    },
    shareNote: { fontFamily: mono, fontSize: 9, color: t.textMuted },
  };
}
