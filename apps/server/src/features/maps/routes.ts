import type { FastifyPluginAsync } from 'fastify';
import { registerExplorerRoutes } from './explorer';
import { registerHeatmapRoutes } from './heatmap';
import { registerRouteRoutes } from './route-api';

/** All /api/maps endpoints. Each area registers its own routes. */
export const mapsRoutes: FastifyPluginAsync = async (app) => {
  registerHeatmapRoutes(app);
  registerExplorerRoutes(app);
  registerRouteRoutes(app);
};
