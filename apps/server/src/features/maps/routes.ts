import type { FastifyPluginAsync } from 'fastify';
import { registerHeatmapRoutes } from './heatmap';

/** All /api/maps endpoints. Each area registers its own routes. */
export const mapsRoutes: FastifyPluginAsync = async (app) => {
  registerHeatmapRoutes(app);
};
