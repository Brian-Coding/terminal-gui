import * as stylex from "@stylexjs/stylex";
import type React from "react";
import { Component } from "react";
import { color, font } from "../../tokens.stylex.ts";

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
				<div {...stylex.props(styles.fallback)}>
					<p {...stylex.props(styles.message)}>Reconnecting…</p>
				</div>
			);
		}
		return this.props.children;
	}
}

const styles = stylex.create({
	fallback: {
		alignItems: "center",
		backgroundColor: color.background,
		display: "flex",
		height: "100vh",
		justifyContent: "center",
	},
	message: {
		color: color.textSoft,
		fontSize: font.size_3,
	},
});
