const mongoose = require('mongoose');

const attendancesSchema = new mongoose.Schema({
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true },
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
  distanceFromClass: { type: Number, default: null },
  manual: { type: Boolean, default: false },
  note: { type: String }
}, {
  timestamps: true
});

// Session bazlı: aynı session'da aynı öğrenci 1 kez
attendancesSchema.index({ sessionId: 1, universityRollNo: 1 }, { unique: true });
// Session bazlı: aynı session'da aynı cihaz 1 kez (fingerprint varsa)
attendancesSchema.index({ sessionId: 1, deviceFingerprint: 1 }, { unique: true, sparse: true });
// Raporlama için date index (backward compat)
attendancesSchema.index({ date: 1 });

module.exports = mongoose.model('Attendance', attendancesSchema);