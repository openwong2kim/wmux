import { Component, type ReactNode, type ErrorInfo } from 'react';
import { t } from '../i18n';
import { useStore } from '../stores';

interface Props {
  children: ReactNode;
  name?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  // A class component cannot use useT(), so it subscribes directly. Without
  // this the fallback keeps whatever language it was rendered in — and the
  // fallback is the one screen the user cannot dismiss and reopen.
  private unsubscribeLocale: (() => void) | null = null;

  componentDidMount() {
    let prev = useStore.getState().locale;
    this.unsubscribeLocale = useStore.subscribe((s) => {
      if (s.locale === prev) return;
      prev = s.locale;
      if (this.state.hasError) this.forceUpdate();
    });
  }

  componentWillUnmount() {
    this.unsubscribeLocale?.();
    this.unsubscribeLocale = null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary:${this.props.name || 'unknown'}]`, error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: 16,
          color: 'var(--accent-red)',
          backgroundColor: 'var(--bg-base)',
          fontFamily: 'ui-monospace, monospace',
          fontSize: 12,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}>
          <div>{t('error.crashed', { message: this.state.error?.message ?? '' })}</div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: '4px 12px',
              backgroundColor: 'var(--bg-surface)',
              color: 'var(--text-main)',
              border: '1px solid var(--bg-overlay)',
              borderRadius: 4,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t('error.retry')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
