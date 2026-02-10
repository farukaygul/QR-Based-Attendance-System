const mongoose = require("mongoose");

const settingsSchema = new mongoose.Schema(
  {
    orgTitle: { type: String, default: "Suluova MYO" },
    courseTitle: { type: String, default: "Yapay Zeka Okuryazarlığı" },
    requireLocation: { type: Boolean, default: true },
    classLat: {
      type: Number,
      default: () => parseFloat(process.env.LATITUDE) || 0,
    },
    classLng: {
      type: Number,
      default: () => parseFloat(process.env.LONGITUDE) || 0,
    },
    radiusMeters: {
      type: Number,
      default: () => parseFloat(process.env.RADIUS) || 50,
    },
  },
  { timestamps: true }
);

/**
 * Singleton: her zaman tek doküman döndürür.
 * Yoksa ENV defaults ile oluşturur.
 */
settingsSchema.statics.getSettings = async function () {
  let doc = await this.findOne();
  if (!doc) {
    doc = await this.create({});
  }
  return doc;
};

module.exports = mongoose.model("Settings", settingsSchema);
