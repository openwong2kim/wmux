#[derive(Clone, Copy, Default)]
pub(crate) struct RefAllocOptions {
    pub(crate) include_bounds: bool,
    pub(crate) interactive_only: bool,
    pub(crate) compact: bool,
    pub(crate) force_renderer_accessibility: bool,
}
