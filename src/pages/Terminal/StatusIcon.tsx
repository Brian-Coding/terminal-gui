import * as stylex from "@stylexjs/stylex";
import {
	IconAlertTriangle,
	IconCircle,
	IconMessageCircle,
	IconSparkles,
	IconTerminal,
	IconWrench,
} from "../../components/ui/Icons.tsx";
import type { StatusIconType } from "../../features/terminal/terminal-utils.ts";
import { color, motion } from "../../tokens.stylex.ts";

export function StatusIcon({
	iconType,
	size,
	active,
	tone = "idle",
}: {
	iconType: StatusIconType;
	size: number;
	active?: boolean;
	tone?: "idle" | "thinking" | "responding" | "error" | "tool";
}) {
	const iconProps = stylex.props(
		styles.icon,
		tone === "idle" && styles.idle,
		tone === "thinking" && styles.thinking,
		tone === "responding" && styles.responding,
		tone === "error" && styles.error,
		tone === "tool" && styles.tool,
		active && styles.active
	);
	switch (iconType) {
		case "sparkles":
			return <IconSparkles size={size} className={iconProps.className} />;
		case "message":
			return <IconMessageCircle size={size} className={iconProps.className} />;
		case "alert":
			return <IconAlertTriangle size={size} className={iconProps.className} />;
		case "wrench":
			return <IconWrench size={size} className={iconProps.className} />;
		case "terminal":
			return <IconTerminal size={size} className={iconProps.className} />;
		default:
			return <IconCircle size={size} className={iconProps.className} />;
	}
}

const pulse = stylex.keyframes({
	from: { opacity: 1 },
	to: { opacity: 0.45 },
});

const styles = stylex.create({
	icon: {
		flexShrink: 0,
	},
	idle: {
		color: color.textMuted,
	},
	thinking: {
		color: color.warning,
	},
	responding: {
		color: "var(--color-inferay-info)",
	},
	error: {
		color: color.danger,
	},
	tool: {
		color: color.accent,
	},
	active: {
		animationDuration: "1.5s",
		animationIterationCount: "infinite",
		animationName: pulse,
		animationTimingFunction: motion.ease,
	},
});
