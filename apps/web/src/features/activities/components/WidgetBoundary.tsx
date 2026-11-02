import { Component, type ReactNode } from 'react';

/**
 * Error boundary around another feature's dashboard widget: a failing widget renders `fallback` instead of
 * taking the whole dashboard down.
 */
export class WidgetBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.warn('[dashboard widget]', error);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
