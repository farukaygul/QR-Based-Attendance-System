const mongoose = require("mongoose");

const sessionSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    policy: {
      type: String,
      enum: ["whitelist", "open"],
      default: "whitelist",
    },
    requireLocation: { type: Boolean, default: true },
    startAt: { type: Date, default: Date.now },
    endAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    createdBy: { type: String, default: "admin" },
  },
  { timestamps: true }
);

// TTL index — Mongo otomatik olarak expiresAt geldiğinde siler
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Aktif session sorgusu: endAt == null VE expiresAt > now
 */
sessionSchema.statics.findActive = function () {
  return this.findOne({
    endAt: null,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });
};

module.exports = mongoose.model("Session", sessionSchema);
