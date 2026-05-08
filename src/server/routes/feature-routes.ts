import { FEATURE_FLAGS } from "../../lib/feature-flags.ts";
import { automationRoutes } from "./automations.ts";
import { goalRoutes } from "./goals.ts";

export function featureRoutes() {
	const routes = {};

	if (FEATURE_FLAGS.goals) {
		Object.assign(routes, goalRoutes());
	}

	if (FEATURE_FLAGS.automations) {
		Object.assign(routes, automationRoutes());
	}

	return routes;
}
