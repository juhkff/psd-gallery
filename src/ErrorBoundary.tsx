import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last-resort guard so a decode/worker failure shows a readable message
 * instead of a blank page on the deployed site.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[psd-gallery] unhandled render error', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="mx-auto max-w-xl p-8">
        <h1 className="mb-2 text-lg font-semibold text-red-300">页面出错了</h1>
        <p className="mb-4 text-sm text-neutral-400">
          可以刷新页面重试。如果问题持续，请把下面的信息反馈给维护者。
        </p>
        <pre className="overflow-auto rounded-lg bg-neutral-900 p-4 text-xs text-neutral-300">
          {error.stack ?? String(error)}
        </pre>
      </div>
    );
  }
}
