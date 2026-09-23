const {
  MAX_ADVANCED_FILTERS,
  MAX_ADVANCED_FILTER_NAME_LENGTH,
  MAX_FILTER_GROUPS,
  MAX_FILTER_RULES_PER_GROUP,
  MAX_FILTER_RULES_TOTAL,
  MAX_FILTER_VALUE_LENGTH
} = require('../services/advancedFilters');

function registerAdvancedFilterRoutes(app, { requireModSession, getDatabaseConnected, getAdvancedFilterManager }) {
  function managerOrUnavailable(res) {
    const manager = getAdvancedFilterManager();
    if (!getDatabaseConnected() || !manager) {
      res.status(503).json({ success: false, error: 'Advanced Filters require MongoDB to be connected.' });
      return null;
    }
    return manager;
  }

  const limits = {
    maxFilters: MAX_ADVANCED_FILTERS,
    maxNameLength: MAX_ADVANCED_FILTER_NAME_LENGTH,
    maxGroups: MAX_FILTER_GROUPS,
    maxRulesPerGroup: MAX_FILTER_RULES_PER_GROUP,
    maxRulesTotal: MAX_FILTER_RULES_TOTAL,
    maxValueLength: MAX_FILTER_VALUE_LENGTH
  };

  app.post('/advanced-filters/list', requireModSession, async (req, res) => {
    const manager = managerOrUnavailable(res);
    if (!manager) return;
    try {
      return res.json({ success: true, filters: await manager.listFilters(), currentStream: manager.getCurrentStreamStatus(), limits });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message || 'Could not load Advanced Filters.' });
    }
  });

  app.post('/advanced-filters/save', requireModSession, async (req, res) => {
    const manager = managerOrUnavailable(res);
    if (!manager) return;
    try {
      return res.json({ success: true, filter: await manager.saveFilter(req.body || {}), limits });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message || 'Could not save Advanced Filter.' });
    }
  });

  app.post('/advanced-filters/delete', requireModSession, async (req, res) => {
    const manager = managerOrUnavailable(res);
    if (!manager) return;
    try {
      await manager.deleteFilter(String(req.body?.id || ''));
      return res.json({ success: true });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message || 'Could not delete Advanced Filter.' });
    }
  });
}

module.exports = { registerAdvancedFilterRoutes };
