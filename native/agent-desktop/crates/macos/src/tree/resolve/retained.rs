use crate::tree::AXElement;
use agent_desktop_core::{AdapterError, IdentifierEvidence};
use core_foundation::{
    base::TCFType,
    data::{CFData, CFDataRef},
};
use std::ffi::{CStr, c_void};
use std::sync::OnceLock;

const TOKEN_PREFIX: &str = "axtok1:";
const RTLD_DEFAULT: *mut c_void = -2_isize as *mut c_void;
const RTLD_LAZY: i32 = 0x1;
const APPLICATION_SERVICES: &CStr =
    c"/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices";

type TokenCreate = unsafe extern "C" fn(accessibility_sys::AXUIElementRef) -> CFDataRef;
type TokenResolve = unsafe extern "C" fn(CFDataRef) -> accessibility_sys::AXUIElementRef;

/// What a saved remote token says about the element it names in this process.
pub(crate) enum TokenLookup {
    NotAToken,
    Unavailable,
    Dead,
    Live(AXElement),
}

struct Symbols {
    create: TokenCreate,
    resolve: TokenResolve,
}

/// Saves the app's own token for `element` as `axtok1:<hex>`, or `None` when the
/// private symbols are missing or the app yields no token for it.
pub(crate) fn capture(element: &AXElement) -> Result<Option<String>, AdapterError> {
    if element.0.is_null() {
        return Err(AdapterError::stale_ref_because(
            "Cannot take a native object token from a null element",
        ));
    }
    let Some(symbols) = symbols() else {
        return Ok(None);
    };
    let data = unsafe { (symbols.create)(element.0) };
    if data.is_null() {
        return Ok(None);
    }
    let data = unsafe { CFData::wrap_under_create_rule(data) };
    Ok(Some(format!("{TOKEN_PREFIX}{}", encode_hex(data.bytes()))))
}

/// Resolves a saved token to the element it names, or says why it could not.
pub(crate) fn resolve_token(token: &str) -> Result<TokenLookup, AdapterError> {
    let Some(hex) = token.strip_prefix(TOKEN_PREFIX) else {
        return Ok(TokenLookup::NotAToken);
    };
    let Some(symbols) = symbols() else {
        return Ok(TokenLookup::Unavailable);
    };
    let Some(bytes) = decode_hex(hex) else {
        return Ok(TokenLookup::Dead);
    };
    let data = CFData::from_buffer(&bytes);
    let element = unsafe { (symbols.resolve)(data.as_concrete_TypeRef()) };
    if element.is_null() {
        return Ok(TokenLookup::Dead);
    }
    Ok(TokenLookup::Live(AXElement(element)))
}

pub(crate) fn evidence(element: &AXElement, identifiers: IdentifierEvidence) -> IdentifierEvidence {
    match capture(element) {
        Ok(Some(token)) => identifiers.with_retained_object(token),
        _ => identifiers,
    }
}

/// Whether this macOS build can create and resolve element tokens.
pub(crate) fn tokens_available() -> bool {
    symbols().is_some()
}

fn symbols() -> Option<&'static Symbols> {
    static SYMBOLS: OnceLock<Option<Symbols>> = OnceLock::new();
    SYMBOLS.get_or_init(load_symbols).as_ref()
}

fn load_symbols() -> Option<Symbols> {
    lookup_symbols(RTLD_DEFAULT).or_else(|| {
        let handle = unsafe { dlopen(APPLICATION_SERVICES.as_ptr(), RTLD_LAZY) };
        if handle.is_null() {
            None
        } else {
            lookup_symbols(handle)
        }
    })
}

fn lookup_symbols(handle: *mut c_void) -> Option<Symbols> {
    let create = symbol(handle, c"_AXUIElementRemoteTokenCreate")?;
    let resolve = symbol(handle, c"_AXUIElementCreateWithRemoteToken")?;
    Some(Symbols {
        create: unsafe { std::mem::transmute::<*mut c_void, TokenCreate>(create) },
        resolve: unsafe { std::mem::transmute::<*mut c_void, TokenResolve>(resolve) },
    })
}

fn symbol(handle: *mut c_void, name: &CStr) -> Option<*mut c_void> {
    let symbol = unsafe { dlsym(handle, name.as_ptr()) };
    (!symbol.is_null()).then_some(symbol)
}

fn encode_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut hex, byte| {
        let _ = write!(hex, "{byte:02x}");
        hex
    })
}

fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if hex.is_empty() || !hex.len().is_multiple_of(2) {
        return None;
    }
    let mut bytes = Vec::with_capacity(hex.len() / 2);
    for pair in hex.as_bytes().chunks_exact(2) {
        bytes.push(u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?);
    }
    Some(bytes)
}

unsafe extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const std::ffi::c_char) -> *mut c_void;
    fn dlopen(path: *const std::ffi::c_char, mode: i32) -> *mut c_void;
}
