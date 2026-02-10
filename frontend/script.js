// --- Session ID & QR Token ---
function getSessionId() {
  const hashParams = new URLSearchParams(window.location.hash.substring(1));
  const hashSession = hashParams.get("sessionId");
  if (hashSession) return hashSession;
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get("sessionId");
}
function getQrToken() {
  const hashParams = new URLSearchParams(window.location.hash.substring(1));
  const hashToken = hashParams.get("qrToken");
  if (hashToken) return hashToken;
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get("qrToken");
}
const sessionId = getSessionId();
const qrToken = getQrToken();

// --- Device Fingerprint ---
async function generateDeviceFingerprint() {
  try {
    const today = new Date().toISOString().split("T")[0];
    const cacheKey = `fingerprint-${today}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) return cached;

    const data = {
      userAgent: navigator.userAgent,
      screen: `${screen.width}x${screen.height}`,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      lang: navigator.language,
      cores: navigator.hardwareConcurrency || "x",
      mem: navigator.deviceMemory || "x",
      touch: "ontouchstart" in window,
      salt: today,
    };

    try {
      const c = document.createElement("canvas");
      c.width = 100;
      c.height = 30;
      const ctx = c.getContext("2d");
      ctx.textBaseline = "top";
      ctx.font = "14px Arial";
      ctx.fillStyle = "#f60";
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = "#069";
      ctx.fillText("Fingerprint", 2, 15);
      data.canvas = c.toDataURL();
    } catch (_) {}

    const str = JSON.stringify(data);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    }
    const fp = hash.toString(16).padStart(8, "0");
    localStorage.setItem(cacheKey, fp);
    return fp;
  } catch (e) {
    return btoa(
      JSON.stringify({
        ua: navigator.userAgent,
        s: `${screen.width}x${screen.height}`,
        salt: new Date().toISOString().split("T")[0],
      })
    );
  }
}

// --- Fetched student data ---
let fetchedStudent = null;

document.addEventListener("DOMContentLoaded", () => {
  const API = window.location.origin;

  // Elements
  const step1 = document.getElementById("step1");
  const step1Open = document.getElementById("step1Open");
  const step2 = document.getElementById("step2");
  const rollInput = document.getElementById("universityRollNo");
  const fetchBtn = document.getElementById("fetchStudentBtn");
  const fetchError = document.getElementById("fetchError");
  const displayName = document.getElementById("displayName");
  const displaySection = document.getElementById("displaySection");
  const displayRollNo = document.getElementById("displayRollNo");
  const backBtn = document.getElementById("backBtn");
  const form = document.getElementById("attendanceForm");
  const statusEl = document.getElementById("status");
  const submitBtn = form ? form.querySelector("button[type='submit']") : null;

  let isSubmitting = false;
  let sessionPolicy = "whitelist"; // varsayılan

  // --- Public settings — başlıkları yükle ---
  fetch(`${API}/api/public/settings`)
    .then((r) => r.json())
    .then((json) => {
      if (json.status === "success" && json.data) {
        const orgEl = document.getElementById("indexOrgTitle");
        const courseEl = document.getElementById("indexCourseTitle");
        if (orgEl && json.data.orgTitle) orgEl.textContent = json.data.orgTitle;
        if (courseEl && json.data.courseTitle) courseEl.textContent = json.data.courseTitle + " Dersi Yoklaması";
      }
    })
    .catch(() => { /* fallback: hardcode değerler kalır */ });

  // --- Session policy algıla ---
  if (sessionId) {
    fetch(`${API}/api/sessions/${encodeURIComponent(sessionId)}/public`)
      .then((r) => r.json())
      .then((json) => {
        if (json.status === "success" && json.data) {
          sessionPolicy = json.data.policy || "whitelist";

          // Oturum başlığını göster
          const sessTitleEl = document.getElementById("indexSessionTitle");
          if (sessTitleEl && json.data.title) {
            sessTitleEl.textContent = "Oturum: " + json.data.title;
            sessTitleEl.classList.remove("hidden");
          }

          if (sessionPolicy === "open") {
            // Whitelist formunu gizle, open formu göster
            step1.classList.add("hidden");
            if (step1Open) {
              step1Open.classList.remove("hidden");
              const titleEl = document.getElementById("openSessionTitle");
              if (titleEl) titleEl.textContent = json.data.title || "Açık Oturum";
            }
          }
        }
      })
      .catch(() => { /* sessizce whitelist'te kal */ });
  }

  // --- OPEN MOD: Yoklama gönder ---
  const openSubmitBtn = document.getElementById("openSubmitBtn");
  if (openSubmitBtn) {
    openSubmitBtn.addEventListener("click", async () => {
      if (isSubmitting) return;
      const openError = document.getElementById("openError");
      openError.classList.add("hidden");

      const nameVal = document.getElementById("openName").value.trim();
      const rollVal = document.getElementById("openRollNo").value.trim();

      if (!nameVal) {
        openError.textContent = "Ad soyad zorunludur.";
        openError.classList.remove("hidden");
        return;
      }

      // Öğrenci no girilmişse 9 hane mi kontrol et
      if (rollVal && !/^\d{9}$/.test(rollVal)) {
        openError.textContent = "Öğrenci numarası girilecekse 9 haneli bir sayı olmalıdır.";
        openError.classList.remove("hidden");
        return;
      }

      if (!sessionId) {
        openError.textContent = "Lütfen önce QR kodu tarayın.";
        openError.classList.remove("hidden");
        return;
      }

      isSubmitting = true;
      openSubmitBtn.disabled = true;
      openSubmitBtn.innerHTML = "Gönderiliyor...";

      try {
        const fingerprint = await generateDeviceFingerprint();

        // Konum al
        const loc = await new Promise((resolve, reject) => {
          if (!navigator.geolocation) { resolve(null); return; }
          navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            () => resolve(null),
            { timeout: 10000, enableHighAccuracy: true }
          );
        });

        const payload = {
          universityRollNo: rollVal || ("9" + Date.now().toString().slice(-8)),
          name: nameVal,
          sessionId,
          deviceFingerprint: fingerprint,
        };
        if (qrToken) payload.qrToken = qrToken;
        if (loc) payload.location = loc;

        const res = await fetch(`${API}/mark-attendance`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();

        if (res.status === 400 && data.message?.includes("zaten")) {
          statusEl.innerText = data.message;
          statusEl.className = "text-center mt-6 text-sm text-yellow-600";
          return;
        }

        if (!res.ok) throw new Error(data.message || "Yoklama kaydedilemedi");

        statusEl.innerText = "Yoklama başarıyla kaydedildi!";
        statusEl.className = "text-center mt-6 text-sm text-green-600";
        if (rollVal) {
          setTimeout(() => {
            window.location.href = `/dashboard.html?rollNo=${encodeURIComponent(rollVal)}`;
          }, 1500);
        }
      } catch (err) {
        openError.textContent = err.message;
        openError.classList.remove("hidden");
      } finally {
        isSubmitting = false;
        openSubmitBtn.disabled = false;
        openSubmitBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>Yoklamayı Gönder`;
      }
    });
  }

  // --- ADIM 1: Bilgileri Getir ---
  fetchBtn.addEventListener("click", async () => {
    const rollNo = rollInput.value.trim();
    fetchError.classList.add("hidden");

    if (!rollNo) {
      fetchError.textContent = "Lütfen öğrenci numaranızı girin.";
      fetchError.classList.remove("hidden");
      return;
    }

    // 9 haneli sayısal kontrol
    if (!/^\d{9}$/.test(rollNo)) {
      fetchError.textContent = "Öğrenci numarası 9 haneli bir sayı olmalıdır.";
      fetchError.classList.remove("hidden");
      return;
    }

    fetchBtn.disabled = true;
    fetchBtn.textContent = "Sorgulanıyor...";

    try {
      const res = await fetch(`${API}/api/students/${encodeURIComponent(rollNo)}`);
      const json = await res.json();

      if (!res.ok || json.status !== "success") {
        throw new Error(json.message || "Öğrenci bulunamadı");
      }

      fetchedStudent = json.data;
      displayName.textContent = fetchedStudent.name || "-";
      displaySection.textContent = fetchedStudent.section || "-";
      displayRollNo.textContent = fetchedStudent.universityRollNo;

      step1.classList.add("hidden");
      step2.classList.remove("hidden");
      statusEl.textContent = "";
    } catch (err) {
      fetchError.textContent = err.message;
      fetchError.classList.remove("hidden");
      fetchedStudent = null;
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.textContent = "Bilgilerimi Getir";
    }
  });

  // Enter tuşu ile de getir
  rollInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      fetchBtn.click();
    }
  });

  // --- Geri Dön ---
  backBtn.addEventListener("click", () => {
    step2.classList.add("hidden");
    step1.classList.remove("hidden");
    fetchedStudent = null;
    statusEl.textContent = "";
  });

  // --- ADIM 2: Yoklama Gönder ---
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isSubmitting || !fetchedStudent) return;
    isSubmitting = true;

    // Session kontrolü
    if (!sessionId) {
      statusEl.innerText = "Lütfen önce QR kodu tarayın.";
      statusEl.className = "text-center mt-6 text-sm text-red-600";
      isSubmitting = false;
      return;
    }

    try {
      // Session doğrula
      const valRes = await fetch(`${API}/api/validate-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const valData = await valRes.json();

      if (!valData.valid) {
        statusEl.innerText = "QR oturumu geçersiz veya süresi dolmuş. Lütfen QR kodu tekrar okutun.";
        statusEl.className = "text-center mt-6 text-sm text-red-600";
        isSubmitting = false;
        return;
      }

      submitBtn.disabled = true;
      submitBtn.innerHTML = "Gönderiliyor...";

      const fingerprint = await generateDeviceFingerprint();

      // Konum al ve gönder
      if (!navigator.geolocation) {
        statusEl.innerText = "Konum servisi desteklenmiyor.";
        statusEl.className = "text-center mt-6 text-sm text-red-600";
        isSubmitting = false;
        submitBtn.disabled = false;
        submitBtn.innerHTML = "Yoklamayı Gönder";
        return;
      }

      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const payload = {
            universityRollNo: fetchedStudent.universityRollNo,
            name: fetchedStudent.name,
            section: fetchedStudent.section,
            classRollNo: fetchedStudent.classRollNo,
            location: { lat: pos.coords.latitude, lng: pos.coords.longitude },
            deviceFingerprint: fingerprint,
            sessionId,
          };
          if (qrToken) payload.qrToken = qrToken;

          try {
            const res = await fetch(`${API}/mark-attendance`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            const data = await res.json();

            if (res.status === 400 && data.message?.includes("zaten")) {
              statusEl.innerText = data.message;
              statusEl.className = "text-center mt-6 text-sm text-yellow-600";
              setTimeout(() => {
                window.location.href = `/dashboard.html?rollNo=${encodeURIComponent(fetchedStudent.universityRollNo)}`;
              }, 1500);
              return;
            }

            if (!res.ok) throw new Error(data.message || "Yoklama kaydedilemedi");

            statusEl.innerText = "Yoklama başarıyla kaydedildi!";
            statusEl.className = "text-center mt-6 text-sm text-green-600";
            setTimeout(() => {
              window.location.href = `/dashboard.html?rollNo=${encodeURIComponent(fetchedStudent.universityRollNo)}`;
            }, 1500);
          } catch (err) {
            statusEl.innerText = err.message;
            statusEl.className = "text-center mt-6 text-sm text-red-600";
          } finally {
            isSubmitting = false;
            submitBtn.disabled = false;
            submitBtn.innerHTML = "Yoklamayı Gönder";
          }
        },
        (locErr) => {
          statusEl.innerText = "Konum alınamadı. Lütfen konum izni verin ve tekrar deneyin.";
          statusEl.className = "text-center mt-6 text-sm text-red-600";
          isSubmitting = false;
          submitBtn.disabled = false;
          submitBtn.innerHTML = "Yoklamayı Gönder";
        },
        { timeout: 10000, enableHighAccuracy: true }
      );
    } catch (err) {
      statusEl.innerText = "Beklenmeyen bir hata oluştu.";
      statusEl.className = "text-center mt-6 text-sm text-red-600";
      isSubmitting = false;
      submitBtn.disabled = false;
      submitBtn.innerHTML = "Yoklamayı Gönder";
    }
  });

  // --- Dashboard Görüntüle ---
  document.getElementById("view-dashboard-btn").addEventListener("click", () => {
    const rollNo = document.getElementById("rollInput").value.trim();
    const accessMsg = document.getElementById("accessMessage");
    if (!rollNo) {
      accessMsg.textContent = "Lütfen öğrenci numaranızı girin.";
      return;
    }
    if (!/^\d{9}$/.test(rollNo)) {
      accessMsg.textContent = "Öğrenci numarası 9 haneli bir sayı olmalıdır.";
      return;
    }
    accessMsg.textContent = "";
    window.location.href = `/dashboard.html?rollNo=${encodeURIComponent(rollNo)}`;
  });
});
