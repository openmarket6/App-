import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Stops one broken panel from taking the whole screen with it.
 *
 * Without this, any render-time error unmounts the entire tree and the person
 * gets a white page with nothing to act on — which is what a single undefined
 * field did on the Drafting page. A field that should be there and is not is a
 * bug worth fixing, but it should cost one card, not the application, and the
 * person should be told which page failed rather than left guessing.
 */
interface Props {
  children: ReactNode;
  /** Where this boundary sits, so the message can name it. */
  label?: string;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in the console deliberately: this is the only place the stack
    // survives, and "it went blank" is not a report anybody can act on.
    console.error('[render error]', this.props.label ?? 'app', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="m-6 rounded-md border border-danger/25 bg-danger-soft px-4 py-3">
        <h2 className="text-sm font-semibold text-danger">
          This {this.props.label ?? 'page'} could not be displayed
        </h2>
        <p className="mt-1 text-[13px] text-ink-soft leading-relaxed max-w-2xl">
          Something on it is not in the shape the screen expected. The rest of the application is
          unaffected — the sidebar still works, and reloading may clear it if the cause was transient.
        </p>
        <p className="mt-2 font-mono text-[12px] text-ink-mute break-words">{error.message}</p>
        <div className="mt-3 flex gap-2">
          <button type="button" className="btn-ghost px-2 py-1 text-[12px]" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button type="button" className="btn-primary px-2 py-1 text-[12px]" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
