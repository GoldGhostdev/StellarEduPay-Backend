'use strict';

const mongoose = require('mongoose');
const tenantScope = require('../plugins/tenantScope');

const reconciliationReportSchema = new mongoose.Schema(
  {
    schoolId:          { type: String, required: true, index: true },
    reportedAt:        { type: Date, required: true, index: true },

    dbTotalCredited:   { type: Number, required: true },
    chainTotalReceived: { type: Number, required: true },

    drift:             { type: Number, required: true },
    driftPercentage:   { type: Number, required: true },

    threshold:         { type: Number, required: true },
    alertRaised:       { type: Boolean, default: false },

    paymentCount:      { type: Number, default: 0 },
    chainTxCount:      { type: Number, default: 0 },

    details:           { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
  }
);

reconciliationReportSchema.index({ schoolId: 1, reportedAt: -1 });
reconciliationReportSchema.index({ schoolId: 1, alertRaised: 1 });

reconciliationReportSchema.plugin(tenantScope, { modelName: 'ReconciliationReport' });

module.exports = mongoose.model('ReconciliationReport', reconciliationReportSchema);
