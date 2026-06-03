import type React from "react";
import { Component } from "react";

export class ErrorBoundary extends Component<
	{ children: React.ReactNode },
	{ hasError: boolean }
> {
	override state = { hasError: false };
	static getDerivedStateFromError() {
		return { hasError: true };
	}
	override componentDidCatch() {
		// Auto-recover after a short delay
		setTimeout(() => this.setState({ hasError: false }), 1500);
	}
	override render() {
		if (this.state.hasError) {
			return (
				<div className="flex h-screen items-center justify-center bg-inferay-black">
					<p className="text-sm text-inferay-soft-white">Reconnecting…</p>
				</div>
			);
		}
		return this.props.children;
	}
}
