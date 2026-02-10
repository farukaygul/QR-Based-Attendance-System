const mongoose = require('mongoose');

const attendancesSchema = new mongoose.Schema({
  name: { type: String, required: true },
  universityRollNo: { type: String, required: true },
  section: { type: String, default: "" },
  classRollNo: { type: String, default: "" },
  date: { type: String, required: true },
  time: {
    type: String,
    default: () => new Date().toLocaleTimeString('tr-TR', { hour12: false })
  },
  location: {
    lat: { type: Number },
    lng: { type: Number }
  },
  deviceFingerprint: { type: String },
  status: { type: String, default: "present" },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  distanceFromClass: { type: Number },
  manual: { type: Boolean, default: false },
  note: { type: String }
}, {
  timestamps: true
});

// universityRollNo + date benzersiz (aynı öğrenci aynı gün 2 kez yoklama alamaz)
attendancesSchema.index({ universityRollNo: 1, date: 1 }, { unique: true });
// deviceFingerprint + date — sparse (manuel kayıtlarda fingerprint olmayabilir)
attendancesSchema.index({ deviceFingerprint: 1, date: 1 }, { sparse: true });

module.exports = mongoose.model('Attendance', attendancesSchema);