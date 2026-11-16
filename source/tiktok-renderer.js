"use strict";

(function () {
  const tiktokState = {
    settings: {},
    accounts: [],
    jobs: [],
    mediaAssets: [],
    filter: "all",
    search: "",
    selectedJobIds: new Set()
  };

  function formatTime(isoStr) {
    if (!isoStr) return "--";
    try {
      const d = new Date(isoStr);
      return d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
    } catch {
      return isoStr;
    }
  }

  function renderStatusBadge(status, progressText) {
    const statusMap = {
      draft: { label: "Nháp", cls: "badge-draft" },
      waiting_content: { label: "Chờ nội dung", cls: "badge-waiting" },
      generating_content: { label: "AI đang viết", cls: "badge-active" },
      waiting_product: { label: "Chờ sản phẩm", cls: "badge-waiting" },
      checking_product: { label: "Đang kiểm tra SP", cls: "badge-active" },
      waiting_product_confirmation: { label: "Chờ duyệt SP", cls: "badge-warning" },
      processing_audio: { label: "Đang ghép nhạc", cls: "badge-active" },
      ready: { label: "Sẵn sàng", cls: "badge-ready" },
      opening_studio: { label: "Mở Studio", cls: "badge-active" },
      uploading: { label: "Đang tải lên", cls: "badge-active" },
      filling_metadata: { label: "Điền nội dung", cls: "badge-active" },
      configuring_schedule: { label: "Cấu hình lịch", cls: "badge-active" },
      submitting: { label: "Đang gửi bài", cls: "badge-active" },
      scheduled: { label: "Đã lên lịch", cls: "badge-success" },
      posted: { label: "Đã đăng", cls: "badge-success" },
      needs_reconciliation: { label: "Cần đối soát", cls: "badge-danger" },
      paused: { label: "Tạm dừng", cls: "badge-paused" },
      failed: { label: "Lỗi", cls: "badge-danger" },
      cancelled: { label: "Đã hủy", cls: "badge-draft" }
    };

    const info = statusMap[status] || { label: status, cls: "badge-draft" };
    return `<span class="badge ${info.cls}" title="${progressText || ''}">${info.label}</span>`;
  }

  function getMediaAsset(id) {
    return tiktokState.mediaAssets.find(a => a.id === id) || null;
  }

  function getAccount(id) {
    return tiktokState.accounts.find(a => a.id === id) || null;
  }

  function renderQueueTable() {
    const tbody = document.getElementById("tiktokQueueTbody");
    const emptyEl = document.getElementById("tiktokEmpty");
    const countBadge = document.getElementById("tiktokNavCount");
    const totalCountEl = document.getElementById("tiktokTotalCount");

    if (!tbody) return;

    let filtered = tiktokState.jobs;
    if (tiktokState.filter !== "all") {
      filtered = filtered.filter(j => {
        if (tiktokState.filter === "ready") return j.status === "ready";
        if (tiktokState.filter === "active") return ["opening_studio", "uploading", "filling_metadata", "submitting"].includes(j.status);
        if (tiktokState.filter === "done") return ["scheduled", "posted"].includes(j.status);
        if (tiktokState.filter === "reconcile") return j.status === "needs_reconciliation";
        if (tiktokState.filter === "failed") return j.status === "failed";
        return true;
      });
    }

    if (tiktokState.search) {
      const q = tiktokState.search.toLowerCase();
      filtered = filtered.filter(j => {
        const title = (j.content?.title || "").toLowerCase();
        const caption = (j.content?.caption || "").toLowerCase();
        const prompt = (j.sourcePrompt || "").toLowerCase();
        return title.includes(q) || caption.includes(q) || prompt.includes(q);
      });
    }

    if (countBadge) countBadge.textContent = tiktokState.jobs.length;
    if (totalCountEl) totalCountEl.textContent = tiktokState.jobs.length;

    if (filtered.length === 0) {
      tbody.innerHTML = "";
      if (emptyEl) emptyEl.style.display = "block";
      return;
    }

    if (emptyEl) emptyEl.style.display = "none";

    tbody.innerHTML = filtered.map((job, idx) => {
      const isSelected = tiktokState.selectedJobIds.has(job.id);
      const videoAsset = getMediaAsset(job.sourceVideoAssetId);
      const uploadAsset = job.uploadVideoAssetId ? getMediaAsset(job.uploadVideoAssetId) : videoAsset;
      const imgAsset = job.productImageAssetId ? getMediaAsset(job.productImageAssetId) : null;
      const account = getAccount(job.accountId);

      const title = job.content?.title || "Chưa có tiêu đề";
      const hashtags = (job.content?.hashtags || []).join(" ");
      const scheduleInfo = job.schedule?.mode === "native_schedule"
        ? `📅 ${formatTime(job.schedule.effectiveTime || job.schedule.targetTime)}`
        : "⚡ Đăng ngay";

      const isPinned = uploadAsset?.pinned === true;

      return `
        <tr data-job-id="${job.id}" class="${isSelected ? 'selected' : ''}">
          <td><input type="checkbox" class="job-check" data-id="${job.id}" ${isSelected ? 'checked' : ''}></td>
          <td>${idx + 1}</td>
          <td>
            <div class="media-cell">
              ${imgAsset ? `<img src="${imgAsset.path}" class="thumb" onerror="this.style.display='none'">` : '<div class="thumb-placeholder">📹</div>'}
              <div class="media-info">
                <b title="${videoAsset?.path || ''}">${videoAsset ? videoAsset.path.split(/[/\\\\]/).pop() : job.id}</b>
                <span class="source-tag">${job.sourceKind === 'muse_result' ? '🎬 Từ Muse' : '📁 File ngoài'}</span>
              </div>
            </div>
          </td>
          <td>
            <div class="account-cell">
              <span class="account-badge ${account ? 'linked' : 'unlinked'}">
                ${account ? `👤 ${account.label} (${account.handle || 'chưa login'})` : '⚠️ Chưa chọn kênh'}
              </span>
            </div>
          </td>
          <td>
            <div class="content-preview">
              <b class="content-title" title="${title}">${title}</b>
              <span class="content-hashtags">${hashtags}</span>
              <span class="cart-mode-tag ${job.accountMode === 'affiliate' ? 'cart' : 'no-cart'}" data-job-id="${job.id}">
                ${job.accountMode === 'affiliate' ? (job.productMatch?.confirmed ? '🛒 Đã duyệt SP' : '⚠️ Cần duyệt SP') : '🚫 Không giỏ'}
              </span>
            </div>
          </td>
          <td>
            <div class="audio-cell">
              <span>${job.audio?.enabled ? `🎵 Nhạc ${job.audio.musicVolume}%` : '🔇 Không nhạc'}</span>
              ${uploadAsset && uploadAsset.kind === 'processed_video' ? `
                <button class="btn-pin ${isPinned ? 'pinned' : ''}" data-asset-id="${uploadAsset.id}" title="${isPinned ? 'Đã ghim (không tự xóa)' : 'Ghim để giữ lâu dài'}">
                  ${isPinned ? '📌' : '📍'}
                </button>
              ` : ''}
            </div>
          </td>
          <td>
            <div class="schedule-cell">
              <span>${scheduleInfo}</span>
            </div>
          </td>
          <td>
            <div class="progress-cell">
              ${renderStatusBadge(job.status, job.progressText)}
              <div class="progress-bar-wrap">
                <div class="progress-bar" style="width: ${job.progress}%"></div>
              </div>
              <span class="progress-text">${job.progress}% - ${job.progressText || ''}</span>
            </div>
          </td>
          <td>
            <div class="action-cell">
              ${job.status === 'needs_reconciliation' ? `<button class="btn-action reconcile" data-id="${job.id}">Đối soát</button>` : ''}
              ${job.status === 'failed' ? `<button class="btn-action retry" data-id="${job.id}">Thử lại</button>` : ''}
              <button class="btn-action edit" data-id="${job.id}">Sửa</button>
              <button class="btn-action delete" data-id="${job.id}">Xóa</button>
            </div>
          </td>
        </tr>
      `;
    }).join("");
  }

  function setupEventListeners() {
    // Tab switching
    const tabMuse = document.getElementById("tabMuse");
    const tabTikTok = document.getElementById("tabTikTok");
    const viewMuse = document.getElementById("viewMuse");
    const viewTikTok = document.getElementById("viewTikTok");

    if (tabMuse && tabTikTok && viewMuse && viewTikTok) {
      tabMuse.addEventListener("click", () => {
        tabMuse.classList.add("active");
        tabTikTok.classList.remove("active");
        viewMuse.style.display = "flex";
        viewTikTok.style.display = "none";
      });

      tabTikTok.addEventListener("click", () => {
        tabTikTok.classList.add("active");
        tabMuse.classList.remove("active");
        viewMuse.style.display = "none";
        viewTikTok.style.display = "flex";
        renderQueueTable();
      });
    }

    // Run button
    const btnRun = document.getElementById("tiktokRun");
    if (btnRun) {
      btnRun.addEventListener("click", async () => {
        if (window.tiktokApp && window.tiktokApp.runJobs) {
          btnRun.disabled = true;
          try {
            const selectedIds = Array.from(tiktokState.selectedJobIds);
            const res = await window.tiktokApp.runJobs(selectedIds.length > 0 ? selectedIds : null);
            console.log("Kết quả chạy jobs:", res);
          } finally {
            btnRun.disabled = false;
          }
        }
      });
    }

    // Pause, Resume, Stop buttons
    const btnPause = document.getElementById("tiktokPause");
    if (btnPause) {
      btnPause.addEventListener("click", async () => {
        if (window.tiktokApp && window.tiktokApp.pauseJobs) {
          await window.tiktokApp.pauseJobs();
        }
      });
    }

    const btnResume = document.getElementById("tiktokResume");
    if (btnResume) {
      btnResume.addEventListener("click", async () => {
        if (window.tiktokApp && window.tiktokApp.resumeJobs) {
          await window.tiktokApp.resumeJobs();
        }
      });
    }

    const btnStop = document.getElementById("tiktokStop");
    if (btnStop) {
      btnStop.addEventListener("click", async () => {
        if (window.tiktokApp && window.tiktokApp.stopJobs) {
          await window.tiktokApp.stopJobs();
        }
      });
    }

    // Add files button
    const btnAddFiles = document.getElementById("tiktokAddFiles");
    if (btnAddFiles) {
      btnAddFiles.addEventListener("click", async () => {
        if (window.tiktokApp && window.tiktokApp.addFiles) {
          const res = await window.tiktokApp.addFiles();
          if (res && res.added) {
            console.log(`Đã thêm ${res.added.length} file vào hàng đợi TikTok.`);
          }
        }
      });
    }

    // Accounts management
    const btnAccounts = document.getElementById("tiktokManageAccounts");
    if (btnAccounts) {
      btnAccounts.addEventListener("click", async () => {
        const action = prompt("Nhập [1] để Thêm kênh mới, [2] để Kiểm tra tất cả kênh:");
        if (action === "1") {
          const label = prompt("Nhập tên gợi nhớ cho kênh (ví dụ: Kênh Thời Trang):");
          if (label && window.tiktokApp && window.tiktokApp.addAccount) {
            await window.tiktokApp.addAccount(label.trim());
          }
        } else if (action === "2") {
          if (window.tiktokApp && window.tiktokApp.checkAccount) {
            for (const acc of tiktokState.accounts) {
              await window.tiktokApp.checkAccount(acc.id);
            }
          }
        }
      });
    }

    // Filters
    const filterButtons = document.querySelectorAll("#tiktokFilters button");
    filterButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        filterButtons.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        tiktokState.filter = btn.getAttribute("data-filter") || "all";
        renderQueueTable();
      });
    });

    // Search
    const searchInput = document.getElementById("tiktokSearch");
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        tiktokState.search = e.target.value.trim();
        renderQueueTable();
      });
    }

    // Table delegate actions
    const tbody = document.getElementById("tiktokQueueTbody");
    if (tbody) {
      tbody.addEventListener("click", async (e) => {
        const btn = e.target.closest("button");
        if (!btn) return;
        const jobId = btn.getAttribute("data-id");
        if (!jobId) return;

        if (btn.classList.contains("reconcile")) {
          const decision = prompt("Chọn kết quả đối soát: [1] Đã Đăng, [2] Đã Lên lịch, [3] Chưa đăng (thử lại)");
          let decVal = null;
          if (decision === "1") decVal = "posted";
          else if (decision === "2") decVal = "scheduled";
          else if (decision === "3") decVal = "not_submitted";

          if (decVal && window.tiktokApp && window.tiktokApp.reconcileJob) {
            await window.tiktokApp.reconcileJob(jobId, decVal);
          }
        }

        if (btn.classList.contains("retry")) {
          if (window.tiktokApp && window.tiktokApp.retryJobs) {
            await window.tiktokApp.retryJobs([jobId]);
          }
        }

        if (btn.classList.contains("delete")) {
          if (confirm("Bạn có chắc muốn xóa job này khỏi hàng đợi không?")) {
            if (window.tiktokApp && window.tiktokApp.removeJobs) {
              await window.tiktokApp.removeJobs([jobId], true);
            }
          }
        }

        if (btn.classList.contains("btn-pin")) {
          const assetId = btn.getAttribute("data-asset-id");
          const isCurrentlyPinned = btn.classList.contains("pinned");
          if (window.tiktokApp && window.tiktokApp.pinAudio && assetId) {
            await window.tiktokApp.pinAudio(assetId, !isCurrentlyPinned);
          }
        }

        const cartTag = e.target.closest(".cart-mode-tag");
        if (cartTag) {
          const jId = cartTag.getAttribute("data-job-id");
          const job = tiktokState.jobs.find(j => j.id === jId);
          if (job && window.tiktokApp && window.tiktokApp.updateJob) {
            const newMode = job.accountMode === "affiliate" ? "no_cart" : "affiliate";
            await window.tiktokApp.updateJob(job.id, { accountMode: newMode }, job.updatedAt);
          }
        }

        if (btn.classList.contains("edit")) {
          const job = tiktokState.jobs.find(j => j.id === jobId);
          if (job) {
            const newTitle = prompt("Chỉnh sửa Tiêu đề (tối đa 60 ký tự):", job.content?.title || "");
            if (newTitle !== null) {
              const newCaption = prompt("Chỉnh sửa Caption (tối đa 2200 ký tự):", job.content?.caption || "");
              if (newCaption !== null) {
                await window.tiktokApp.updateJob(job.id, {
                  content: {
                    title: newTitle.trim(),
                    caption: newCaption.trim()
                  }
                }, job.updatedAt);
              }
            }
          }
        }
      });
    }

    // IPC state listener
    if (window.tiktokApp && window.tiktokApp.onTikTokState) {
      window.tiktokApp.onTikTokState((state) => {
        if (state) {
          tiktokState.settings = state.settings || {};
          tiktokState.accounts = state.accounts || [];
          tiktokState.jobs = state.jobs || [];
          tiktokState.mediaAssets = state.mediaAssets || [];
          renderQueueTable();
        }
      });
    }

    // Initial load
    if (window.tiktokApp && window.tiktokApp.getState) {
      window.tiktokApp.getState().then(s => {
        if (s) {
          tiktokState.settings = s.settings || {};
          tiktokState.accounts = s.accounts || [];
          tiktokState.jobs = s.jobs || [];
          tiktokState.mediaAssets = s.mediaAssets || [];
          renderQueueTable();
        }
      }).catch(err => console.error("Lỗi lấy state TikTok ban đầu:", err));
    }
  }

  window.addEventListener("DOMContentLoaded", setupEventListeners);
})();
