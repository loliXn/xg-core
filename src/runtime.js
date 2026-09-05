import { renderPostPanel } from './panels.js';
// Shared viewer behavior. Host operations and persisted preferences enter through the bridge.
export function createViewerRuntime(bridge) {
function createLauncher(options) {
    if(document.getElementById(options.id))return document.getElementById(options.id);
    const button=document.createElement('button');button.type='button';button.id=options.id;button.className=options.className||options.id;
    button.textContent=options.label||'Gallery';button.title=options.title||button.textContent;
    button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();options.onClick();});
    document.body.append(button);return button;
}
function beginOpen() {
    const overlay=ensureOverlay();
    overlay.style.display='block';overlay.style.pointerEvents='none';overlay.style.removeProperty('visibility');overlay.style.removeProperty('opacity');
    overlay.classList.remove('ms-closing','active','ms-open');overlay.classList.add('ms-opening');
    return overlay;
}
function resetLayout() {
    const overlay=bridge.state.overlay;
    overlay.classList.remove('ms-grid-mode','ms-stage-fullscreen','ms-thumbs-hidden');
    const thumbs=overlay.querySelector('.ms-thumbs-wrap');if(thumbs)thumbs.style.display='block';
}
function finishOpen() {
    const overlay=bridge.state.overlay;if(!overlay || !bridge.state.open)return;
    overlay.classList.add('ms-open');overlay.classList.remove('ms-opening');overlay.style.pointerEvents='';
    syncVerticalFitMediaBox();
}
function clearViewerMedia() {
    const overlay=bridge.state.overlay;if(!overlay)return;
    ++bridge.state.renderToken;
    clearFullscreenIdleTimer();stopThumbTrackAnimation();
    if(bridge.state.mediaFitObserver){bridge.state.mediaFitObserver.disconnect();bridge.state.mediaFitObserver=null;}
    for(const key of ['thumbsWindowRaf','gridWindowRaf'])if(bridge.state[key]){cancelAnimationFrame(bridge.state[key]);bridge.state[key]=null;}
    overlay.classList.remove('ms-grid-mode','ms-stage-fullscreen');
    const grid=overlay.querySelector('.ms-grid');if(grid)grid.replaceChildren();
    bridge.state.gridPool=[];bridge.state.gridSizer=null;
    const wrap=overlay.querySelector('.ms-media-wrap');
    if(wrap){
        delete wrap.dataset.msVerticalFitBound;
        wrap.querySelectorAll('video,audio').forEach(media=>{
            media.pause();media.removeAttribute('src');media.querySelectorAll('source').forEach(source=>source.remove());
            try{media.load();}catch{}
        });
        wrap.querySelectorAll('iframe').forEach(frame=>frame.src='about:blank');wrap.replaceChildren();
    }
}
function revealHost() {
    const overlay=bridge.state.overlay;if(!overlay)return;
    overlay.classList.remove('ms-closing');
    if(!bridge.state.open){overlay.classList.remove('active','ms-open');overlay.style.display='none';overlay.style.pointerEvents='none';}
}
function showPostPanel(model, item) {
    const panel = bridge.state.overlay && bridge.state.overlay.querySelector('.ms-tags-overlay');
    if (!panel) return;
    panel.querySelector('.ms-tags-header h3').textContent = model.title || 'Post';
    renderPostPanel({content:panel.querySelector('.ms-tags-content'),model,captionControls:content => appendCaptionModeControls(content,item)});
    updateMediaCaptionOverlay(item);
}
function setInfoPanelVisible(show) {
    const overlay=bridge.state.overlay;if(!overlay)return;
    overlay.classList.toggle('ms-has-tags-panel',!!show);
    overlay.querySelector('.ms-tags-overlay').classList.toggle('active',!!show);
    overlay.querySelector('[data-act="show-tags"]').classList.toggle('active',!!show);
    requestAnimationFrame(() => syncVerticalFitMediaBox());
}
function isInfoPanelVisible() {return !!(bridge.state.overlay && bridge.state.overlay.querySelector('.ms-tags-overlay.active'));}
function setTitlePanelVisible(show) {
    if(!bridge.state.overlay)return;
    bridge.state.overlay.classList.toggle('ms-reddit-row-open',!!show);
    bridge.state.overlay.querySelector('[data-act="show-tags"]').classList.toggle('active',!!show);
    requestAnimationFrame(() => syncVerticalFitMediaBox());
}
function refreshGridSize() {
    if(!bridge.state.overlay)return;
    bridge.state.overlay.style.setProperty('--ms-grid-size',bridge.gridThumbSize+'px');
    const slider=bridge.state.overlay.querySelector('.ms-grid-size-slider');
    if(slider)slider.value=bridge.gridThumbSize;
    const label=bridge.state.overlay.querySelector('.ms-grid-size-value');if(label)label.textContent=bridge.gridThumbSize+'px';
    if(bridge.state.gridMode)syncGridWindow();
}
function renderTitleRow(model) {
    const overlay=bridge.state.overlay;if(!overlay)return;
    setTitlePanelVisible(bridge.state.tagsPanelWanted && model);
    if(!model)return;
    const row=overlay.querySelector('.ms-reddit-info-row');
    const title=row.querySelector('.ms-reddit-title');title.textContent=model.title||'';title.href=model.permalink||'#';
    const meta=row.querySelector('.ms-reddit-meta');meta.replaceChildren();
    (model.links||[]).forEach((data,index) => {
        if(index)meta.append(document.createTextNode(' • '));
        const link=document.createElement(data.href?'a':'span');link.textContent=data.label;
        if(data.href){link.href=data.href;link.target='_blank';link.rel='noopener noreferrer';}
        meta.append(link);
    });
    row.querySelector('[data-rdvote="upvote"]').classList.toggle('upvoted',!!model.upvoted);
    row.querySelector('[data-rdvote="downvote"]').classList.toggle('downvoted',!!model.downvoted);
    row.querySelector('.ms-reddit-score').textContent=model.score==null || model.score===''?'•':String(model.score).replace(/\s*points?\s*$/i,'');
    row.querySelector('[data-rdsave]').classList.toggle('saved',!!model.saved);
    row.querySelector('.ms-reddit-save-label').textContent=model.saved?'Saved':'Save';
}
function paintTopbar(model) {
    const overlay=bridge.state.overlay;if(!overlay)return;
    const loop=overlay.querySelector('[data-act="loop-toggle"]');loop.style.display=model.video?'':'none';loop.classList.toggle('active',!!model.loop);
    const favorite=overlay.querySelector('[data-act="fav-toggle"]');favorite.style.display=model.favoriteVisible?'':'none';favorite.title=model.favoriteTitle;favorite.classList.toggle('active',!!model.favoriteActive);
    const info=overlay.querySelector('[data-act="show-tags"]');info.style.display=model.infoVisible?'':'none';setBtnLabel(info,model.infoLabel);
    if(isInfoPanelVisible())toggleTagsPanel(true);
    updateTopbarCompact();
}
function showStageNotice(wrap, text) {
        if (!wrap) return;
        let pill = wrap.querySelector('.ms-stage-notice');
        if (!pill) {
            pill = document.createElement('div');
            pill.className = 'ms-stage-notice ms-resolve-loading';
            pill.innerHTML = '<div class="ms-resolve-spinner"></div><div class="ms-resolve-text"></div>';
            wrap.appendChild(pill);
        }
        const txt = pill.querySelector('.ms-resolve-text');
        if (txt) txt.textContent = text;
    }

function hideStageNotice(wrap) {
        if (!wrap) return;
        const pill = wrap.querySelector('.ms-stage-notice');
        if (pill) pill.remove();
    }

function showGalleryEndNotice() {
        const now = Date.now();
        if (now - bridge.galleryEndNoticeLastAt < 5000) return;
        bridge.galleryEndNoticeLastAt = now;

        if (bridge.state.overlay) {
            let toast = bridge.state.overlay.querySelector('.ms-gallery-end-toast');
            if (!toast) {
                toast = document.createElement('div');
                toast.className = 'ms-gallery-end-toast';
                toast.textContent = 'End of gallery - no more media found';
                bridge.state.overlay.appendChild(toast);
            }
            requestAnimationFrame(() => toast.classList.add('active'));
            if (bridge.galleryEndNoticeTimer) clearTimeout(bridge.galleryEndNoticeTimer);
            bridge.galleryEndNoticeTimer = setTimeout(() => {
                toast.classList.remove('active');
                setTimeout(() => { if (toast.isConnected) toast.remove(); }, 220);
            }, 1600);
        }
    }

function getLoadingOverlay() {
        let overlay = document.getElementById('ms-loading-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'ms-loading-overlay';
            document.body.appendChild(overlay);
        }
        return overlay;
    }

function showLoadingOverlay(mainText, subText) {
        bridge.ensureMsStyles();
        const overlay = getLoadingOverlay();
        overlay.innerHTML = '<div class="ms-loading-main"></div><div class="ms-loading-sub"></div>';
        overlay.querySelector('.ms-loading-main').textContent = mainText || 'Loading gallery...';
        overlay.querySelector('.ms-loading-sub').textContent = subText || '';
        overlay.style.display = 'flex';
    }

function updateLoadingOverlay(mainText, subText) {
        const overlay = document.getElementById('ms-loading-overlay');
        if (!overlay || overlay.style.display === 'none') return;
        const main = overlay.querySelector('.ms-loading-main');
        const sub = overlay.querySelector('.ms-loading-sub');
        if (main && typeof mainText === 'string') main.textContent = mainText;
        if (sub && typeof subText === 'string') sub.textContent = subText;
    }

function hideLoadingOverlay() {
        const overlay = document.getElementById('ms-loading-overlay');
        if (overlay) overlay.style.display = 'none';
    }

function ensureOverlay() {
        bridge.ensureMsStyles();
        if (bridge.state.overlay) return bridge.state.overlay;

        const coreApi = bridge.xgalleryCoreApi();
        const overlay = globalThis.XGalleryCore.createOverlayShell({
            document: document,
            shadowCss: coreApi && coreApi.OVERLAY_CSS,
            classes: [
                bridge.captionFeed || bridge.reservedPostHeader ? 'ms-rich-info' : '',
                bridge.captionFeed ? 'ms-imaglr' : '',
                bridge.reservedPostHeader ? 'ms-bdsmlr' : '',
                bridge.resetHostStyles ? 'ms-reset-host ms-pixeldrain' : '',
                bridge.titleCard && bridge.legacyHost() ? 'ms-old-reddit' : ''
            ],
            fontFamily: bridge.folderFavorites ? '"Space Grotesk", ui-sans-serif, system-ui, sans-serif' : '',
            showInfo: bridge.categorizedTags || bridge.reservedPostHeader || bridge.captionFeed || bridge.titleCard,
            infoLabel: bridge.captionFeed ? 'Description' : (bridge.reservedPostHeader || bridge.titleCard ? 'Info' : 'Tags')
        });

        if (coreApi && typeof coreApi.bindFilterBar === 'function') {
            bridge.state.filterBar = coreApi.bindFilterBar(overlay.querySelector('.ms-filter-bar'), {
                state: bridge.galleryFilter,
                onChange: (next) => {
                    bridge.galleryFilter = next;
                    bridge.filterMode = next.kind === 'videos' ? 2 : (next.kind === 'images' ? 1 : 0);
                    try {
                        bridge.savePreference(bridge.FILTER_MODE_KEY, bridge.filterMode);
                        bridge.savePreference(bridge.GALLERY_FILTER_KEY, JSON.stringify(next));
                    } catch (e) { }
                    if (bridge.state.open) bridge.rebuildFilteredAndRender();
                }
            });
        }

        overlay.style.setProperty('--ms-grid-size', bridge.gridThumbSize + 'px');
        const sizeSlider = overlay.querySelector('.ms-grid-size-slider');
        const sizeValueEl = overlay.querySelector('.ms-grid-size-value');
        if (sizeValueEl) sizeValueEl.textContent = bridge.gridThumbSize + 'px';
        if (sizeSlider) {
            sizeSlider.value = bridge.gridThumbSize;
            let sizeApplyRaf = null;
            let sizePersistTimer = null;
            sizeSlider.addEventListener('input', () => {
                const val = parseInt(sizeSlider.value, 10) || 160;
                bridge.gridThumbSize = val;
                if (sizeValueEl) sizeValueEl.textContent = val + 'px';

                if (sizeApplyRaf === null) {
                    sizeApplyRaf = requestAnimationFrame(() => {
                        sizeApplyRaf = null;
                        overlay.style.setProperty('--ms-grid-size', bridge.gridThumbSize + 'px');
                        if (bridge.state.gridMode) syncGridWindow();
                    });
                }

                if (sizePersistTimer) clearTimeout(sizePersistTimer);
                sizePersistTimer = setTimeout(() => {
                    bridge.savePreference('MS_BETTER_GRID_SIZE', bridge.gridThumbSize);
                }, 250);
            });
            sizeSlider.addEventListener('click', (e) => e.stopPropagation());
        }

        const gridWrap = overlay.querySelector('.ms-grid-wrap');
        if (gridWrap) {
            gridWrap.addEventListener('scroll', () => {
                if (!bridge.state.gridMode) return;
                if (gridWrap.scrollTop + gridWrap.clientHeight >= gridWrap.scrollHeight - 600) {
                    bridge.checkTriggerInfiniteScroll(true);
                }
            }, { passive: true });

            gridWrap.addEventListener('click', (e) => {
                const cell = e.target.closest('.ms-grid-cell');
                if (cell) {
                    e.preventDefault();
                    e.stopPropagation();
                    const index = parseInt(cell.getAttribute('data-grid-index'), 10);
                    if (Number.isFinite(index) && index >= 0 && index < bridge.state.items.length) {
                        bridge.rememberNavigationDirection(bridge.state.currentIndex, index, bridge.state.items.length);
                        bridge.state.currentIndex = index;
                        bridge.state.activeNode = bridge.state.items[index] ? bridge.state.items[index].node : null;
                        setGridMode(false);
                    }
                }
            });

            const loadMoreBtn = gridWrap.querySelector('.ms-grid-loadmore');
            if (loadMoreBtn) {
                if (!bridge.categorizedTags && !bridge.remotePhotoAlbums && !bridge.timelineFeed && !bridge.folderFavorites && !bridge.reservedPostHeader) loadMoreBtn.classList.add('ms-hidden');
                loadMoreBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    loadMoreBtn.textContent = 'Loading...';
                    setTimeout(() => { loadMoreBtn.textContent = 'Load more'; }, 5000);
                    bridge.requestMoreAtGalleryEnd();
                });
            }
        }

        overlay.addEventListener('click', onOverlayClick);
        overlay.addEventListener('wheel', onOverlayWheel, { passive: false });
        overlay.addEventListener('mousemove', (e) => { if (bridge.state.stageFullscreen && e.clientY <= 120) wakeFullscreenTopbar(); });
        bridge.state.overlay = overlay;
        bindTagsPanelResizer();
        bindTitleRowResizer();
        applyTagsFontSize(bridge.tagsFontSize, false);
        bindTopbarCompactObserver();

        const mediaWrap = overlay.querySelector('.ms-media-wrap');
        if (mediaWrap) {
            mediaWrap.addEventListener('wheel', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (bridge.panWheelScroll && bridge.state.pan && bridge.state.pan.active) {
                    bridge.state.pan.panBy(e.shiftKey ? -e.deltaY : -(e.deltaX || 0), e.shiftKey ? 0 : -e.deltaY);
                    return;
                }
                const direction = getWheelNavigationDirection(e);
                if (direction) navigateFromWheel(direction);
            }, { passive: false, capture: true });

            mediaWrap.addEventListener('mouseleave', () => {
                const shield = mediaWrap.querySelector('.ms-iframe-shield');
                if (shield) {
                    shield.style.pointerEvents = 'auto';
                }
            });

            let swipeStartX = 0;
            let swipeStartY = 0;
            let swipeTime = 0;
            mediaWrap.addEventListener('touchstart', (e) => {
                if (e.touches.length === 1) {
                    swipeStartX = e.touches[0].clientX;
                    swipeStartY = e.touches[0].clientY;
                    swipeTime = Date.now();
                }
            }, { passive: true });
            mediaWrap.addEventListener('touchend', (e) => {
                if (e.changedTouches.length === 1) {
                    const endX = e.changedTouches[0].clientX;
                    const endY = e.changedTouches[0].clientY;
                    const diffX = swipeStartX - endX;
                    const diffY = Math.abs(swipeStartY - endY);
                    if (Date.now() - swipeTime < 500 && Math.abs(diffX) > 50 && Math.abs(diffX) > diffY) {
                        bridge.navigate(diffX > 0 ? 1 : -1);
                    }
                }
            }, { passive: true });
        }

        const thumbsWrap = overlay.querySelector('.ms-thumbs-wrap');
        if (thumbsWrap) {
            thumbsWrap.addEventListener('wheel', (e) => {

                if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                    e.preventDefault();
                    e.stopPropagation();
                    const direction = getWheelNavigationDirection(e);
                    if (direction) navigateFromWheel(direction);
                }
            }, { passive: false, capture: true });
        }

        bindPositionControl();

        const zoomSlider = overlay.querySelector('.ms-zoom-slider');
        if (zoomSlider) {
            let zoomApplyRaf = null;
            zoomSlider.addEventListener('input', () => {
                const valueEl = overlay.querySelector('.ms-zoom-value');
                if (valueEl) valueEl.textContent = Math.round(parseFloat(zoomSlider.value) * 100) + '%';
                if (!bridge.state.pan || !bridge.state.pan.active) {
                    const wrap = overlay.querySelector('.ms-media-wrap');
                    const img = wrap ? wrap.querySelector('img.ms-media.ms-ready') : null;
                    if (wrap && img) {
                        enablePanForImage(wrap, img);
                    }
                }

                if (zoomApplyRaf !== null) return;
                zoomApplyRaf = requestAnimationFrame(() => {
                    zoomApplyRaf = null;
                    if (bridge.state.pan && bridge.state.pan.active && typeof bridge.state.pan.updateZoom === 'function') {
                        bridge.state.pan.updateZoom(parseFloat(zoomSlider.value));
                    }
                });
            });
            zoomSlider.addEventListener('pointerdown', (e) => e.stopPropagation());
            zoomSlider.addEventListener('click', (e) => e.stopPropagation());
        }

        document.body.appendChild(overlay.msRootHost || overlay);
        bridge.state.overlay = overlay;
        return overlay;
    }

function onOverlayClick(e) {

        const filterApi = bridge.state.filterBar;
        const filterPopup = e.target.closest('.ms-filter-bar');
        const filterTrigger = e.target.closest('[data-act="filter-toggle"]');
        if (filterApi && filterApi.isOpen && filterApi.isOpen() && !filterPopup && !filterTrigger) {
            filterApi.close();
            if (!e.target.closest('[data-act]')) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
        }

        const rdVote = e.target.closest('[data-rdvote]');
        const rdSave = e.target.closest('[data-rdsave]');
        if (rdVote || rdSave) {
            e.preventDefault();
            e.stopPropagation();
            const rdEntry = bridge.state.items[bridge.state.currentIndex];
            const rdItem = rdEntry ? (rdEntry.item || rdEntry) : null;
            if (bridge.hasTitleMetadata(rdItem)) {
                if (rdVote) bridge.vote(rdItem, rdVote.getAttribute('data-rdvote'));
                else bridge.savePost(rdItem);
            }
            return;
        }

        const actionNode = e.target.closest('[data-act]');
        if (actionNode) {
            const act = actionNode.getAttribute('data-act');

            if (act === 'close') bridge.closeGallery();
            else if (act === 'prev') bridge.navigate(-1);
            else if (act === 'next') bridge.navigate(1);
            else if (act === 'x-like' || act === 'x-bookmark') {
                const entry = bridge.state.items[bridge.state.currentIndex];
                const item = entry ? (entry.item || entry) : null;
                if (bridge.actionPostId(item)) bridge.performPostAction(act === 'x-like' ? 'like' : 'bookmark', bridge.actionPostId(item));
            }
            else if (act === 'loop-toggle') {
                bridge.globalLoop = !bridge.globalLoop;
                bridge.savePreference('MS_BETTER_VIDEO_LOOP', bridge.globalLoop);
                const video = bridge.state.overlay ? bridge.state.overlay.querySelector('.ms-media-wrap video') : null;
                if (video) video.loop = bridge.globalLoop;
                bridge.updateTopbarStates();
            } else if (act === 'fav-toggle') {
                const entry = bridge.state.items[bridge.state.currentIndex];
                const item = entry ? (entry.item || entry) : null;
                if (bridge.folderFavorites && item) {
                    bridge.openFavoriteFolders(item, actionNode);
                } else if (item && item.postId) {
                    item.isFavorited = !item.isFavorited;
                    bridge.toggleFavoriteOnSite(item.postId, item.isFavorited);
                    bridge.updateTopbarStates();
                }
            } else if (act === 'show-tags') {
                if (bridge.titleCard) {

                    toggleTagsPanel(!bridge.state.overlay.classList.contains('ms-reddit-row-open'));
                } else {
                    const tagsOverlay = bridge.state.overlay.querySelector('.ms-tags-overlay');
                    toggleTagsPanel(!(tagsOverlay && tagsOverlay.classList.contains('active')));
                }
            } else if (act === 'tags-font') {
                const step = parseInt(actionNode.getAttribute('data-val'), 10) || 0;
                applyTagsFontSize(bridge.tagsFontSize + step, true);
            } else if (act === 'tags-close') {
                toggleTagsPanel(false);
            } else if (act === 'view-toggle') {
                setGridMode(!bridge.state.gridMode);
            } else if (act === 'filter-toggle') {
                if (bridge.state.filterBar && bridge.state.filterBar.toggle) bridge.state.filterBar.toggle();
            } else if (act === 'pan-toggle') {
                togglePanMode();
            } else if (act === 'fullscreen-toggle') {
                toggleStageFullscreen();
            } else if (act === 'hd') {
                if (typeof bridge.state.hdUpgradeRun === 'function') {
                    const run = bridge.state.hdUpgradeRun;
                    bridge.state.hdUpgradeRun = null;
                    run();
                }
            } else if (act === 'thumbs' || act === 'thumbs-toggle') {
                const val = actionNode.getAttribute('data-val');
                if (val) toggleThumbs(val === 'off');
                else toggleThumbs();
            } else if (act === 'download') {
                bridge.downloadCurrentItem();
            } else if (act === 'link') {
                const currentItem = bridge.state.items[bridge.state.currentIndex];
                if (currentItem && currentItem.item && currentItem.item.src) {
                    window.open(currentItem.item.src, '_blank');
                }
            } else if (act === 'filter') {
                const val = parseInt(actionNode.getAttribute('data-val'), 10);
                bridge.filterMode = val;
                bridge.savePreference(bridge.FILTER_MODE_KEY, bridge.filterMode);
                bridge.rebuildFilteredAndRender();
            } else if (act === 'fit') {
                const val = actionNode.getAttribute('data-val');
                bridge.fitVertical = val === 'vertical';
                bridge.savePreference('MS_BETTER_FIT_VERTICAL', bridge.fitVertical);
                applyFitClass();
                updateButtons();
            }

            return;
        }

        if (e.target.closest('.ms-tags-panel, .ms-tags-resizer')) return;

        const clickedMedia = e.target.closest('.ms-media-wrap img, .ms-media-wrap video, .ms-media-wrap iframe, .ms-iframe-shield, .ms-media-box');
        const clickedNav = e.target.closest('.ms-nav, .ms-gallery-topbar, .ms-filter-bar, .ms-thumbs-wrap, .ms-counter, .ms-dropdown, .ms-grid-cell, .ms-grid-loadmore, .ms-grid-controls, .ms-grid-wrap, .ms-grid, .ms-reddit-info-row');
        if (!clickedMedia && !clickedNav) {

            if (bridge.state.gridMode) {
                bridge.closeGallery();
                return;
            }

            if (bridge.state.cameFromGrid) {
                setGridMode(true);
                return;
            }
            bridge.closeGallery();
        }
    }

function tagsPanelIsScrollable(panel) {
        if (!panel) return false;
        const scroller = panel.querySelector('.ms-tags-content') || panel;
        return (scroller.scrollHeight - scroller.clientHeight) > 1;
    }

function onOverlayWheel(e) {
        if (bridge.state.gridMode) return;
        const target = e.target;
        if (target && target.closest('.ms-thumbs-wrap, .ms-gallery-controls, .ms-filter-bar')) return;
        const tagsPanel = target && target.closest('.ms-tags-overlay');
        if (tagsPanel && tagsPanelIsScrollable(tagsPanel)) return;
        e.preventDefault();
        if (bridge.panWheelScroll && bridge.state.pan && bridge.state.pan.active && target && target.closest('.ms-media-wrap')) {
            bridge.state.pan.panBy(0, -e.deltaY);
            return;
        }
        const direction = getWheelNavigationDirection(e);
        if (direction) navigateFromWheel(direction);
    }

function navigateFromWheel(direction) {
        bridge.wheelNavPending += direction;
        if (bridge.wheelNavRaf) return;
        bridge.wheelNavRaf = requestAnimationFrame(() => {
            bridge.wheelNavRaf = 0;
            const delta = bridge.wheelNavPending;
            bridge.wheelNavPending = 0;
            if (delta) bridge.navigate(delta);
        });
    }

function getWheelNavigationDirection(e) {
        if (!e || typeof e.deltaY !== 'number' || e.deltaY === 0) return 0;

        const direction = e.deltaY > 0 ? 1 : -1;
        if (bridge.state.wheelDirection && bridge.state.wheelDirection !== direction) {
            bridge.state.wheelDeltaCarry = 0;
        }
        bridge.state.wheelDirection = direction;

        let deltaAmount = Math.abs(e.deltaY);
        if (e.deltaMode === 1) deltaAmount *= 16;
        else if (e.deltaMode === 2) deltaAmount *= (window.innerHeight || 900);

        bridge.state.wheelDeltaCarry += deltaAmount;
        if (bridge.state.wheelDeltaCarry < 64) return 0;

        bridge.state.wheelDeltaCarry = 0;
        return direction;
    }

function updateDropdownActiveStates() {
        if (!bridge.state.overlay) return;

        bridge.state.overlay.querySelectorAll('.ms-dropdown-item[data-act="filter"]').forEach(item => {
            const val = parseInt(item.getAttribute('data-val'), 10);
            item.classList.toggle('active', val === bridge.filterMode);
        });

        bridge.state.overlay.querySelectorAll('.ms-dropdown-item[data-act="fit"]').forEach(item => {
            const val = item.getAttribute('data-val');
            item.classList.toggle('active', (val === 'vertical') === bridge.fitVertical);
        });

        const hidden = bridge.state.overlay.classList.contains('ms-thumbs-hidden');
        bridge.state.overlay.querySelectorAll('.ms-dropdown-item[data-act="thumbs"]').forEach(item => {
            const val = item.getAttribute('data-val');
            item.classList.toggle('active', (val === 'off') === hidden);
        });

    }

function setBtnLabel(btn, text) {
        if (!btn) return;
        const label = btn.querySelector(".ms-btn-label");
        if (label) label.textContent = text;
        else btn.textContent = text;
        btn.title = text;
    }

function measureRowContentWidth(row) {
        let total = 0;
        let shown = 0;
        for (let i = 0; i < row.children.length; i++) {
            const kid = row.children[i];
            if (kid.offsetParent === null && !kid.getClientRects().length) continue;
            total += kid.getBoundingClientRect().width;
            shown++;
        }
        if (shown > 1) {
            const gap = parseFloat(bridge.getComputedStyle(row).columnGap) || 0;
            total += gap * (shown - 1);
        }
        return total;
    }

function topbarLayoutSignature(topbar, controls) {
        const center = topbar.querySelector('.ms-gallery-center');
        const vis = (el) => el
            ? Array.prototype.map.call(el.children, (k) => (k.style.display === 'none' ? '0' : '1')).join('')
            : '';
        return topbar.clientWidth + '|' + vis(controls) + '|' + vis(center);
    }

function updateTopbarCompact() {
        if (!bridge.state.overlay) return;
        const topbar = bridge.state.overlay.querySelector('.ms-gallery-topbar');
        const controls = bridge.state.overlay.querySelector('.ms-gallery-controls');
        if (!topbar || !controls) return;

        const sig = topbarLayoutSignature(topbar, controls);
        if (topbar.dataset.msCompactSig === sig) return;
        topbar.dataset.msCompactSig = sig;

        topbar.classList.remove('ms-icons-only');
        topbar.classList.remove('ms-topbar-tight');

        if (measureRowContentWidth(controls) > controls.clientWidth + 1) {
            topbar.classList.add('ms-icons-only');
            if (measureRowContentWidth(controls) > controls.clientWidth + 1) {
                topbar.classList.add('ms-topbar-tight');
            }
        }
    }

function bindTopbarCompactObserver() {
        if (!bridge.state.overlay) return;
        const topbar = bridge.state.overlay.querySelector('.ms-gallery-topbar');
        if (!topbar || topbar.dataset.msCompactBound === '1') return;
        topbar.dataset.msCompactBound = '1';

        let pending = false;
        const ro = new ResizeObserver(() => {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => {
                pending = false;
                updateTopbarCompact();
            });
        });
        ro.observe(topbar);
        updateTopbarCompact();
    }

function updateButtons() {
        if (!bridge.state.overlay) return;
        const triggerFilter = bridge.state.overlay.querySelector('[data-act="filter-trigger"]');
        const triggerFit = bridge.state.overlay.querySelector('[data-act="fit-trigger"]');
        const triggerThumbs = bridge.state.overlay.querySelector('[data-act="thumbs-trigger"], [data-act="thumbs-toggle"]');

        if (triggerFilter) {
            if (bridge.filterMode === 1) setBtnLabel(triggerFilter, 'Filter: Img');
            else if (bridge.filterMode === 2) setBtnLabel(triggerFilter, 'Filter: Vid');
            else if (bridge.filterMode === 3) setBtnLabel(triggerFilter, 'Filter: Img+GIF');
            else setBtnLabel(triggerFilter, 'Filter: All');
        }
        if (triggerFit) {
            setBtnLabel(triggerFit, bridge.fitVertical ? 'Fit: Vert' : 'Fit: Std');
            triggerFit.style.display = bridge.state.gridMode ? 'none' : '';
        }
        if (triggerThumbs) {
            const hidden = bridge.state.overlay.classList.contains('ms-thumbs-hidden');
            triggerThumbs.classList.toggle('active', !hidden);
            triggerThumbs.style.display = bridge.state.gridMode ? 'none' : '';
        }
        const triggerView = bridge.state.overlay.querySelector('[data-act="view-toggle"]');
        if (triggerView) {
            setBtnLabel(triggerView, bridge.state.gridMode ? 'Viewer' : 'Grid');
        }
        const triggerPan = bridge.state.overlay.querySelector('[data-act="pan-toggle"]');
        if (triggerPan) {
            const panActive = !!(bridge.state.pan && bridge.state.pan.active);
            triggerPan.classList.toggle('active', panActive);
            triggerPan.style.display = bridge.state.gridMode ? 'none' : '';
        }
        const triggerFullscreen = bridge.state.overlay.querySelector('[data-act="fullscreen-toggle"]');
        if (triggerFullscreen) {
            triggerFullscreen.classList.toggle('active', !!bridge.state.stageFullscreen);
            triggerFullscreen.style.display = bridge.state.gridMode ? 'none' : '';
        }

        if (bridge.state.gridMode) {
            const loopBtn = bridge.state.overlay.querySelector('[data-act="loop-toggle"]');
            if (loopBtn) loopBtn.style.display = 'none';
            const favBtn = bridge.state.overlay.querySelector('[data-act="fav-toggle"]');
            if (favBtn) favBtn.style.display = 'none';
            const tagsBtn = bridge.state.overlay.querySelector('[data-act="show-tags"]');
            if (tagsBtn) tagsBtn.style.display = 'none';
            updateHdButton('hidden');
            toggleTagsPanel(false, true);
        }
        updateDropdownActiveStates();
        updateTopbarCompact();
    }

function updatePositionControl(force) {
        if (!bridge.state.overlay) return;
        const input = bridge.state.overlay.querySelector('.ms-position-control .ms-index-input');
        const total = bridge.state.overlay.querySelector('.ms-position-total');
        if (!input || !total) return;
        const position = bridge.galleryPositionSnapshot();
        const length = position.length;
        const currentIndex = position.currentIndex;
        const inputRoot = input.getRootNode && input.getRootNode();
        const editing = (document.activeElement === input || (inputRoot && inputRoot.activeElement === input)) && input.dataset.msDirty === '1';
        if (force || !editing) input.value = length ? String(currentIndex + 1) : '0';
        const digits = String(Math.max(1, length)).length;
        input.style.setProperty('width', Math.max(1, digits) + 'ch', 'important');
        input.maxLength = digits;
        total.textContent = String(length);
        input.setAttribute('aria-label', length
            ? 'Go to image, ' + (currentIndex + 1) + ' of ' + length
            : 'No images');
    }

function commitPositionInput(input) {
        const raw = String(input.value || '').trim();
        const parsed = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
        input.dataset.msDirty = '0';
        if (!bridge.state.items.length || !Number.isFinite(parsed)) {
            updatePositionControl(true);
            return;
        }
        const target = Math.max(1, Math.min(bridge.state.items.length, parsed)) - 1;
        if (target === bridge.state.currentIndex) {
            updatePositionControl(true);
            return;
        }
        bridge.rememberNavigationDirection(bridge.state.currentIndex, target, bridge.state.items.length);
        bridge.state.currentIndex = target;
        bridge.state.activeNode = bridge.state.items[target] ? bridge.state.items[target].node : null;
        bridge.renderCurrent();
    }

function bindPositionControl() {
        if (!bridge.state.overlay) return;
        const control = bridge.state.overlay.querySelector('.ms-position-control');
        const input = control && control.querySelector('.ms-index-input');
        if (!control || !input || control.dataset.msBound === '1') return;
        control.dataset.msBound = '1';
        control.addEventListener('click', (event) => event.stopPropagation());
        input.addEventListener('focus', () => input.select());
        input.addEventListener('input', () => { input.dataset.msDirty = '1'; });
        input.addEventListener('blur', () => commitPositionInput(input));
        input.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
                event.preventDefault();
                commitPositionInput(input);
                input.blur();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                input.dataset.msDirty = '0';
                updatePositionControl(true);
                input.blur();
            } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'PageUp' || event.key === 'PageDown') {
                event.preventDefault();
                const step = event.key.indexOf('Page') === 0 ? 10 : 1;
                const direction = event.key === 'ArrowDown' || event.key === 'PageDown' ? -1 : 1;
                input.value = String(Math.max(1, Math.min(bridge.state.items.length, (parseInt(input.value, 10) || bridge.state.currentIndex + 1) + direction * step)));
                input.dataset.msDirty = '1';
            }
        });
        updatePositionControl(true);
    }

function ensureMediaBox(wrap) {
        return globalThis.XGalleryCore.ensureMediaBox(document, wrap);
    }

function syncVerticalFitMediaBox(media) {
        if (!bridge.state.overlay) return;
        const wrap = bridge.state.overlay.querySelector('.ms-media-wrap');
        if (!wrap) return;
        if (wrap.dataset.msVerticalFitBound !== '1' && typeof ResizeObserver !== 'undefined') {
            wrap.dataset.msVerticalFitBound = '1';
            let pending = false;
            const observer = new ResizeObserver(() => {
                if (pending) return;
                pending = true;
                requestAnimationFrame(() => {
                    pending = false;
                    syncVerticalFitMediaBox();
                });
            });
            observer.observe(wrap);
            bridge.state.mediaFitObserver = observer;
        }
        const box = ensureMediaBox(wrap);
        const target = (media && wrap.contains(media) ? media : null) || (box && box.querySelector('img.ms-media, video.ms-media')) ||
            (wrap && wrap.querySelector('img.ms-media, video.ms-media'));
        if (!box) return;
        if (!target || target.classList.contains('ms-pannable')) {
            box.style.removeProperty('width');
            box.style.removeProperty('height');
            return;
        }
        if (target.parentElement !== box) box.appendChild(target);

        const naturalWidth = target.videoWidth || target.naturalWidth || 0;
        const naturalHeight = target.videoHeight || target.naturalHeight || 0;
        const wrapWidth = wrap.clientWidth;
        const wrapHeight = wrap.clientHeight;
        if (!naturalWidth || !naturalHeight || !wrapWidth || !wrapHeight) return;

        const scale = Math.min(wrapWidth / naturalWidth, wrapHeight / naturalHeight);
        box.style.width = Math.max(1, Math.round(naturalWidth * scale)) + 'px';
        box.style.height = Math.max(1, Math.round(naturalHeight * scale)) + 'px';
        target.style.removeProperty('width');
        target.style.removeProperty('height');
    }

function applyFitClass() {
        if (!bridge.state.overlay) return;
        if (bridge.fitVertical) bridge.state.overlay.classList.add('ms-fit-vertical');
        else bridge.state.overlay.classList.remove('ms-fit-vertical');
        syncVerticalFitMediaBox();
    }

function toggleThumbs(forceHide) {
        if (!bridge.state.overlay) return;
        const el = bridge.state.overlay.querySelector('.ms-thumbs-wrap');

        const btn = bridge.state.overlay.querySelector('[data-act="thumbs-trigger"], [data-act="thumbs-toggle"]');
        if (!el) return;
        const hide = typeof forceHide === 'boolean' ? forceHide : el.style.display !== 'none';
        el.style.display = hide ? 'none' : 'block';
        bridge.state.overlay.classList.toggle('ms-thumbs-hidden', hide);
        if (btn) btn.classList.toggle('active', !hide);
        updateDropdownActiveStates();
    }

function animateFlyToGrid(fromRect, src, targetCell) {
        try {
            const toRect = targetCell.getBoundingClientRect();
            if (!toRect.width || !toRect.height) return;

            const ghost = document.createElement('img');
            ghost.src = src;
            ghost.style.cssText = 'position:fixed; z-index:2147483647; object-fit:cover; border-radius:6px;'
                + 'pointer-events:none; margin:0; will-change:transform;'
                + 'left:' + toRect.left + 'px; top:' + toRect.top + 'px;'
                + 'width:' + toRect.width + 'px; height:' + toRect.height + 'px;'
                + 'transform-origin: top left;';
            const dx = fromRect.left - toRect.left;
            const dy = fromRect.top - toRect.top;
            const sx = fromRect.width / toRect.width;
            const sy = fromRect.height / toRect.height;
            ghost.style.transform = 'translate(' + dx + 'px, ' + dy + 'px) scale(' + sx + ', ' + sy + ')';
            document.body.appendChild(ghost);
            targetCell.style.visibility = 'hidden';

            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    ghost.style.transition = 'transform 200ms ease';
                    ghost.style.transform = 'none';
                });
            });
            setTimeout(() => {
                targetCell.style.visibility = '';
                ghost.remove();
            }, 260);
        } catch (e) {
            try { targetCell.style.visibility = ''; } catch (e2) { }
        }
    }

function setGridMode(on) {
        if (!bridge.state.overlay) return;
        const enable = !!on;
        if (enable === !!bridge.state.gridMode) return;

        let flyRect = null;
        let flySrc = '';
        if (enable) {
            disablePan();
            const mediaEl = bridge.state.overlay.querySelector('.ms-media-wrap img.ms-media.ms-ready, .ms-media-wrap video.ms-media');
            if (mediaEl) {
                const r = mediaEl.getBoundingClientRect();
                if (r.width > 2 && r.height > 2) {
                    flyRect = { left: r.left, top: r.top, width: r.width, height: r.height };
                    if (mediaEl.tagName === 'IMG') flySrc = mediaEl.currentSrc || mediaEl.src || '';
                    else flySrc = mediaEl.getAttribute('poster') || '';
                }
            }
            if (flyRect && !flySrc) {
                const curEntry = bridge.state.items[bridge.state.currentIndex];
                const curItem = curEntry ? (curEntry.item || curEntry) : null;
                if (curItem) flySrc = curItem.thumbSrc || '';
            }
        }

        bridge.state.gridMode = enable;
        bridge.state.overlay.classList.toggle('ms-grid-mode', enable);
        if (enable) {
            const wrap = bridge.state.overlay.querySelector('.ms-media-wrap');
            if (wrap) {
                const existingMedia = wrap.querySelectorAll('video, audio, iframe');
                existingMedia.forEach(media => {
                    if (media.tagName === 'VIDEO' || media.tagName === 'AUDIO') {
                        media.pause();
                        media.removeAttribute('src');
                    }
                });
                wrap.innerHTML = '';
            }
            setTopbarLoading(false);
            renderGrid();
            const grid = bridge.state.overlay.querySelector('.ms-grid');
            const active = grid ? grid.querySelector('.ms-grid-cell.active') : null;
            if (active) active.scrollIntoView({ block: 'center', behavior: 'auto' });
            if (active && flyRect && flySrc) animateFlyToGrid(flyRect, flySrc, active);
        } else {
            bridge.state.cameFromGrid = true;
            renderThumbs();
            bridge.renderCurrent();

            if (bridge.state.tagsPanelWanted) bridge.applyTagsPanel(true);
        }
        updateButtons();
    }

function buildGridCell(entry, index) {
        const item = entry.item || entry;
        const cell = document.createElement('button');
        cell.type = 'button';
        const hdSrc = bridge.getHdSrc(item);
        if (hdSrc) cell.setAttribute('data-hd-src', hdSrc);
        const cacheClass = (hdSrc && !bridge.state.cachedImageUrls.has(hdSrc) && !item._msMediaLoaded) ? ' ms-uncached' : '';
        cell.className = 'ms-grid-cell' + cacheClass + (index === bridge.state.currentIndex ? ' active' : '');
        cell.setAttribute('data-grid-index', index);

        const thumbSrc = item.thumbSrc || item.src;
        const isVideo = item.type === 'video' || item.type === 'iframe' || item.expectedVideo || item.xUnplayable;
        const hasPoster = !!(item.thumbSrc && item.thumbSrc !== item.src && !bridge.isPlaceholderUrl(item.thumbSrc));

        if (bridge.isPlaceholderUrl(thumbSrc) || (isVideo && !hasPoster && !bridge.canExtractMp4Poster(item, thumbSrc))) {
            cell.classList.add('ms-grid-placeholder');
            cell.appendChild(createPlaceholderIcon(isVideo));
            let domain = 'unknown';
            try {
                if (item.src) domain = new URL(item.src).hostname.replace('www.', '');
            } catch (err) { domain = 'error'; }
            const domainSpan = document.createElement('div');
            domainSpan.className = 'ms-domain';
            domainSpan.textContent = domain;
            cell.appendChild(domainSpan);
        } else {

            const isVideoThumb = isVideo && !hasPoster &&
                (bridge.isVideoThumbSource(thumbSrc) || !bridge.isImageThumbSource(thumbSrc));
            if (isVideoThumb) {
                appendVideoThumbMedia(cell, item, thumbSrc, isVideo, 'ms-grid-placeholder');
            } else {
                const img = document.createElement('img');
                img.loading = 'lazy';
                img.referrerPolicy = 'no-referrer';
                img.onload = function () { img.classList.add('ms-loaded'); };
                if (bridge.isFreezableAnimatedThumb(item)) {

                    img.src = thumbSrc;
                    bridge.freezeAnimatedThumbnail(img, item);
                } else {
                    bridge.setCachedImgSrc(img, thumbSrc);
                }
                img.onerror = function () {
                    if (img.parentNode === cell && !cell.classList.contains('ms-grid-placeholder')) {
                        cell.classList.add('ms-grid-placeholder');
                        cell.innerHTML = '';
                        cell.appendChild(createPlaceholderIcon(isVideo));
                    }
                };
                cell.appendChild(img);
            }
        }

        if (isVideo && !bridge.isFreezableAnimatedThumb(item)) {
            const videoBadge = document.createElement('div');
            videoBadge.className = 'ms-thumb-video-icon';
            videoBadge.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="#fff"/></svg>';
            cell.appendChild(videoBadge);
        } else if (bridge.isFreezableAnimatedThumb(item)) {
            const gifBadge = document.createElement('div');
            gifBadge.className = 'ms-thumb-gif-icon';
            gifBadge.textContent = bridge.animatedThumbLabel(item);
            cell.appendChild(gifBadge);
        }

        const idxBadge = document.createElement('div');
        idxBadge.className = 'ms-grid-idx';
        idxBadge.textContent = index + 1;
        cell.appendChild(idxBadge);

        cell.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            bridge.rememberNavigationDirection(bridge.state.currentIndex, index, bridge.state.items.length);
            bridge.state.currentIndex = index;
            bridge.state.activeNode = bridge.state.items[index] ? bridge.state.items[index].node : null;
            setGridMode(false);
        });

        return cell;
    }

function renderGrid() {
        if (!bridge.state.overlay) return;
        bridge.syncCoreItems('grid-render');
        const grid = bridge.state.overlay.querySelector('.ms-grid');
        const gridWrap = bridge.state.overlay.querySelector('.ms-grid-wrap');
        if (!grid) return;
        const loadMoreBtn = gridWrap ? gridWrap.querySelector('.ms-grid-loadmore') : null;
        if (loadMoreBtn) loadMoreBtn.textContent = 'Load more';
        syncGridWindow();
    }

function disablePan() {
        if (bridge.state.pan && bridge.state.pan.cleanup) {
            try { bridge.state.pan.cleanup(); } catch (e) { }
        }
        bridge.state.pan = null;
        syncVerticalFitMediaBox();
        updateButtons();
        if (bridge.state.overlay) {
            const sliderWrap = bridge.state.overlay.querySelector('.ms-zoom-slider-wrap');
            if (sliderWrap) sliderWrap.classList.add('ms-zoom-idle');
        }
    }

function applyTitleRowHeight(px) {
        if (!bridge.state.overlay) return;
        const h = Math.round(Math.min(bridge.TITLE_ROW_MAX, Math.max(bridge.TITLE_ROW_MIN, px)));
        bridge.state.overlay.style.setProperty('--ms-reddit-row-h', h + 'px');

        const fs = Math.round(Math.min(28, Math.max(15, 15 + (h - bridge.TITLE_ROW_MIN) * 0.055)));
        bridge.state.overlay.style.setProperty('--ms-reddit-title-fs', fs + 'px');

        const lines = Math.max(1, Math.floor((h - 43) / Math.round(fs * 1.4)));
        bridge.state.overlay.style.setProperty('--ms-reddit-lines', String(lines));
        return h;
    }

function applyTagsFontSize(px, persist) {
        if (!bridge.state.overlay) return;
        const size = Math.round(Math.min(bridge.MS_TAGS_FONT_MAX, Math.max(bridge.MS_TAGS_FONT_MIN, px || 15)));
        bridge.tagsFontSize = size;
        bridge.state.overlay.style.setProperty('--ms-tags-font', size + 'px');
        if (persist) {
            if (typeof bridge.savePreference === 'function') {
                try { bridge.savePreference('MS_BETTER_TAGS_FONT', size); } catch (err) { }
            }
        }
    }

function bindTitleRowResizer() {
        if (!bridge.state.overlay) return;
        const grip = bridge.state.overlay.querySelector('.ms-reddit-resizer');
        const row = bridge.state.overlay.querySelector('.ms-reddit-info-row');
        if (!grip || !row || grip.dataset.msBound === '1') return;
        grip.dataset.msBound = '1';

        let dragging = false;
        const onDown = (e) => {
            if (e.button !== 0) return;
            dragging = true;
            bridge.state.overlay.classList.add('ms-reddit-resizing');
            try { grip.setPointerCapture(e.pointerId); } catch (err) { }
            e.preventDefault();
            e.stopPropagation();
        };
        const onMove = (e) => {
            if (!dragging) return;

            const bottom = row.getBoundingClientRect().bottom;
            applyTitleRowHeight(bottom - e.clientY);
            e.preventDefault();
        };
        const onUp = (e) => {
            if (!dragging) return;
            dragging = false;
            bridge.state.overlay.classList.remove('ms-reddit-resizing');
            try { grip.releasePointerCapture(e.pointerId); } catch (err) { }
            const val = parseInt(bridge.state.overlay.style.getPropertyValue('--ms-reddit-row-h'), 10) || 0;
            if (val) {
                bridge.titleRowHeight = val;
                if (typeof bridge.savePreference === 'function') {
                    try { bridge.savePreference('MS_BETTER_REDDIT_H', val); } catch (err) { }
                }
            }
        };
        grip.addEventListener('pointerdown', onDown);
        grip.addEventListener('pointermove', onMove);
        grip.addEventListener('pointerup', onUp);
        grip.addEventListener('pointercancel', onUp);
        grip.addEventListener('click', (e) => e.stopPropagation());

        if (bridge.titleRowHeight >= bridge.TITLE_ROW_MIN) applyTitleRowHeight(bridge.titleRowHeight);
    }

function bindTagsPanelResizer() {
        if (!bridge.state.overlay) return;
        const grip = bridge.state.overlay.querySelector('.ms-tags-resizer');
        const overlayEl = bridge.state.overlay.querySelector('.ms-tags-overlay');
        if (!grip || !overlayEl || grip.dataset.msBound === '1') return;
        grip.dataset.msBound = '1';

        let dragging = false;
        const MIN_W = 240;
        const onDown = (e) => {
            if (e.button !== 0) return;
            dragging = true;
            bridge.state.overlay.classList.add('ms-tags-resizing');
            try { grip.setPointerCapture(e.pointerId); } catch (err) { }
            e.preventDefault();
            e.stopPropagation();
        };
        const onMove = (e) => {
            if (!dragging) return;
            const left = overlayEl.getBoundingClientRect().left;
            const maxW = Math.max(MIN_W, window.innerWidth - left - 220);
            const next = Math.round(Math.min(maxW, Math.max(MIN_W, e.clientX - left)));
            bridge.state.overlay.style.setProperty('--ms-tags-w', next + 'px');
            e.preventDefault();
        };
        const onUp = (e) => {
            if (!dragging) return;
            dragging = false;
            bridge.state.overlay.classList.remove('ms-tags-resizing');
            try { grip.releasePointerCapture(e.pointerId); } catch (err) { }
            const val = bridge.state.overlay.style.getPropertyValue('--ms-tags-w');
            if (val && typeof bridge.savePreference === 'function') {
                try { bridge.savePreference('MS_BETTER_TAGS_W', parseInt(val, 10) || 0); } catch (err) { }
            }
        };
        grip.addEventListener('pointerdown', onDown);
        grip.addEventListener('pointermove', onMove);
        grip.addEventListener('pointerup', onUp);
        grip.addEventListener('pointercancel', onUp);
        grip.addEventListener('click', (e) => e.stopPropagation());

        if (typeof bridge.tagsPanelWidth === 'number' && bridge.tagsPanelWidth >= MIN_W) {
            bridge.state.overlay.style.setProperty('--ms-tags-w', bridge.tagsPanelWidth + 'px');
        }
    }

function toggleTagsPanel(show, keepWanted) {
        if (!keepWanted) bridge.state.tagsPanelWanted = !!show;
        return bridge.applyTagsPanel(show);
    }

function captionHtmlFromItem(item) {
        if (!item) return '';
        const postInfo = item.postInfo || null;
        const captions = (postInfo && Array.isArray(postInfo.captions)) ? postInfo.captions : [];
        let html = captions.map((cap) => cap && cap.html).filter(Boolean).join('');
        if (!html) html = item.description || item.caption || '';
        return html || '';
    }

function captionFitsSnapchat(el) {
        if (!el) return false;
        const cs = window.getComputedStyle(el);
        const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.25) || 28;
        return el.scrollHeight <= (lh * 3) + 4;
    }

function setCaptionMode(mode, item, fromRemote, edge) {
        bridge.captionMode = bridge.normalizeCaptionMode(mode);
        if (edge !== undefined) bridge.captionEdge = bridge.normalizeCaptionEdge(edge);
        if (!fromRemote && typeof bridge.savePreference === 'function') {
            try {
                bridge.savePreference(bridge.CAPTION_MODE_KEY, bridge.captionMode);
                bridge.savePreference(bridge.CAPTION_EDGE_KEY, bridge.captionEdge);
            } catch (e) { }
        }
        const current = item || (bridge.state.items[bridge.state.currentIndex] && (bridge.state.items[bridge.state.currentIndex].item || bridge.state.items[bridge.state.currentIndex]));
        updateMediaCaptionOverlay(current);
        if (bridge.state.overlay) {
            bridge.state.overlay.querySelectorAll('.ms-caption-mode button').forEach((btn) => {
                btn.classList.toggle('active', btn.getAttribute('data-caption-mode') === bridge.captionMode);
            });
        }
    }

function clickCaptionModeButton(mode, item) {
        const next = bridge.nextCaptionPlacement(bridge.captionMode, bridge.captionEdge, mode);
        bridge.captionMode = next.mode;
        bridge.captionEdge = next.edge;
        setCaptionMode(bridge.captionMode, item, false, bridge.captionEdge);
    }

function handleCaptionModeMessage(event) {
        if (!event || !event.data || event.data.type !== 'ms-gallery-caption-mode') return;
        setCaptionMode(event.data.mode, null, true, event.data.edge);
    }

function applyCaptionSnapInset(overlay) {
        if (!overlay) return;
        const box = overlay.parentElement;
        const boxH = (box && box.clientHeight) || 0;
        const barH = overlay.offsetHeight || 40;
        const range = Math.max(1, boxH - barH);
        const y = bridge.normalizeCaptionSnapY(bridge.captionSnapY);
        overlay.style.top = Math.round(y * range) + 'px';
        overlay.style.bottom = 'auto';
    }

function bindCaptionSnapDrag(overlay) {
        if (!overlay || overlay.dataset.msSnapDrag === '1') return;
        overlay.dataset.msSnapDrag = '1';
        let dragging = false;
        let startY = 0;
        let startTop = 0;
        let range = 1;
        overlay.addEventListener('pointerdown', (e) => {
            if (e.target.closest && e.target.closest('a')) return;
            e.preventDefault();
            e.stopPropagation();
            dragging = true;
            overlay.style.cursor = 'grabbing';
            try { overlay.setPointerCapture(e.pointerId); } catch (err) { }
            const box = overlay.parentElement;
            const boxH = (box && box.clientHeight) || 0;
            const barH = overlay.offsetHeight || 40;
            range = Math.max(1, boxH - barH);
            startY = e.clientY;
            startTop = overlay.offsetTop || 0;
        });
        overlay.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            e.preventDefault();
            const top = Math.max(0, Math.min(range, startTop + (e.clientY - startY)));
            bridge.captionSnapY = bridge.normalizeCaptionSnapY(top / range);
            overlay.style.top = Math.round(top) + 'px';
            overlay.style.bottom = 'auto';
        });
        const endDrag = () => {
            if (!dragging) return;
            dragging = false;
            overlay.style.cursor = 'grab';
            if (typeof bridge.savePreference === 'function') {
                try { bridge.savePreference('MS_CAPTION_SNAP_Y', bridge.captionSnapY); } catch (err) { }
            }
        };
        overlay.addEventListener('pointerup', endDrag);
        overlay.addEventListener('pointercancel', endDrag);
        overlay.addEventListener('click', (e) => e.stopPropagation());
    }

function updateMediaCaptionOverlay(item) {
        if (!bridge.state.overlay) return;
        const wrap = bridge.state.overlay.querySelector('.ms-media-wrap');
        if (!wrap) return;
        wrap.querySelectorAll('.ms-caption-overlay').forEach((el) => el.remove());
        const slot = bridge.state.overlay.querySelector('.ms-panel-caption');
        const html = captionHtmlFromItem(item);
        let mode = bridge.captionMode;
        if (mode === 'popup' || !html || (!bridge.reservedPostHeader && !bridge.captionFeed)) {
            if (slot) slot.hidden = false;
            return;
        }
        const host = wrap.querySelector('.ms-media-box') || wrap;
        const overlay = document.createElement('div');
        const edge = bridge.captionEdge === 'top' ? 'top' : 'bottom';
        overlay.className = 'ms-caption-overlay ms-caption-' + edge + (mode === 'snapchat' ? ' ms-caption-snapchat' : '');
        overlay.innerHTML = html;
        overlay.querySelectorAll('a').forEach((a) => {
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.addEventListener('click', (e) => e.stopPropagation());
        });
        host.appendChild(overlay);
        if (mode === 'snapchat' && !captionFitsSnapchat(overlay)) {
            overlay.remove();
            mode = 'popup';
        } else if (mode === 'snapchat') {
            applyCaptionSnapInset(overlay);
            bindCaptionSnapDrag(overlay);
        }
        if (slot) slot.hidden = mode === 'popup' ? false : true;
    }

function appendCaptionModeControls(content, item) {
        if (!content || (!bridge.reservedPostHeader && !bridge.captionFeed)) return;
        const row = document.createElement('div');
        row.className = 'ms-caption-mode';
        [['popup', 'Popup'], ['overlay', 'Overlay'], ['snapchat', 'Snapchat']].forEach(([mode, label]) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.setAttribute('data-caption-mode', mode);
            btn.textContent = label;
            if (bridge.captionMode === mode) btn.classList.add('active');
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                clickCaptionModeButton(mode, item);
            });
            row.appendChild(btn);
        });
        content.appendChild(row);
    }

function setTopbarLoading(on) {
        if (!bridge.state.overlay) return;
        const spinner = bridge.state.overlay.querySelector('.ms-topbar-spinner');

        if (spinner) spinner.style.visibility = on ? 'visible' : 'hidden';
    }

function updateHdButton(status) {
        if (!bridge.state.overlay) return;
        const btn = bridge.state.overlay.querySelector('[data-act="hd"]');
        if (!btn) return;
        if (status === 'ready') {
            btn.style.display = '';
            btn.classList.remove('loading');
            btn.classList.remove('ms-hd-max');
            btn.title = 'Load full resolution';
        } else if (status === 'loading') {
            btn.style.display = '';
            btn.classList.add('loading');
            btn.classList.remove('ms-hd-max');
            btn.title = 'Loading full resolution...';
        } else if (status === 'max') {

            btn.style.display = '';
            btn.classList.remove('loading');
            btn.classList.add('ms-hd-max');
            btn.title = 'Showing the highest resolution available';
        } else {
            btn.style.display = 'none';
            btn.classList.remove('loading');
            btn.classList.remove('ms-hd-max');
        }

        updateTopbarCompact();
    }

function enablePanForImage(wrap, img, opts) {
        if (!wrap || !img || !img.naturalWidth || !img.naturalHeight) return false;
        disablePan();

        const zoomMode = !!(opts && opts.zoom);
        let wrapW = wrap.clientWidth;
        let wrapH = wrap.clientHeight;
        if (!wrapW || !wrapH) return false;

        let scale;
        if (opts && typeof opts.scale === 'number') {

            scale = opts.scale;
        } else if (zoomMode) {
            scale = 1;
        } else if (bridge.fitVertical) {

            const margin = Math.round(window.innerHeight * 0.08);
            scale = Math.min(1, (wrapH - margin) / img.naturalHeight);
        } else {
            const margin = Math.round(window.innerWidth * 0.08);
            scale = Math.min(1, (wrapW - margin) / img.naturalWidth);
        }

        let dispW = Math.round(img.naturalWidth * scale);
        let dispH = Math.round(img.naturalHeight * scale);

        img.classList.add('ms-pannable');
        if (img.parentElement && img.parentElement.classList.contains('ms-media-box')) wrap.appendChild(img);

        img.style.width = img.naturalWidth + 'px';
        img.style.height = img.naturalHeight + 'px';
        img.style.transformOrigin = '0 0';
        img.style.setProperty('inset', '0 auto auto 0', 'important');
        img.style.setProperty('margin', '0', 'important');
        wrap.classList.add('ms-pan-enabled');

        let x = (wrapW - dispW) / 2;
        let y = dispH <= wrapH ? (wrapH - dispH) / 2 : 0;
        if (opts && typeof opts.initialX === 'number') x = opts.initialX;
        if (opts && typeof opts.initialY === 'number') y = opts.initialY;

        let panRaf = null;
        const clampAndApply = () => {
            if (dispW <= wrapW) x = (wrapW - dispW) / 2;
            else x = Math.min(0, Math.max(wrapW - dispW, x));
            if (dispH <= wrapH) y = (wrapH - dispH) / 2;
            else y = Math.min(0, Math.max(wrapH - dispH, y));
            const s = img.naturalWidth ? dispW / img.naturalWidth : 1;
            img.style.transform = 'translate(' + x + 'px, ' + y + 'px) scale(' + s + ')';
        };

        const scheduleClampAndApply = () => {
            if (panRaf !== null) return;
            panRaf = requestAnimationFrame(() => {
                panRaf = null;
                clampAndApply();
            });
        };
        clampAndApply();

        const panResize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
            wrapW = wrap.clientWidth;
            wrapH = wrap.clientHeight;
            if (wrapW && wrapH) scheduleClampAndApply();
        }) : null;
        if (panResize) panResize.observe(wrap);

        const sliderWrap = bridge.state.overlay.querySelector('.ms-zoom-slider-wrap');
        const slider = bridge.state.overlay.querySelector('.ms-zoom-slider');
        if (sliderWrap && slider) {
            sliderWrap.classList.remove('ms-zoom-idle');
            const minScale = Math.min(0.05, scale * 0.1);
            const maxScale = Math.max(5.0, scale * 5.0);
            slider.min = minScale;
            slider.max = maxScale;

            slider.step = (maxScale - minScale) / 200;
            slider.value = scale;
            const valueEl = bridge.state.overlay.querySelector('.ms-zoom-value');
            if (valueEl) valueEl.textContent = Math.round(scale * 100) + '%';
        }

        let dragging = false;
        let lastX = 0;
        let lastY = 0;
        let downX = 0;
        let downY = 0;

        const onPointerDown = (e) => {
            if (e.button !== 0) return;
            dragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            downX = e.clientX;
            downY = e.clientY;
            if (bridge.state.pan) bridge.state.pan.moved = false;
            wrap.classList.add('ms-pan-dragging');
            try { img.setPointerCapture(e.pointerId); } catch (err) { }
            e.preventDefault();
        };
        const onPointerMove = (e) => {
            if (!dragging) return;
            x += e.clientX - lastX;
            y += e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            if (bridge.state.pan && Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) {
                bridge.state.pan.moved = true;
            }
            scheduleClampAndApply();
            e.preventDefault();
        };
        const onPointerUp = (e) => {
            dragging = false;
            wrap.classList.remove('ms-pan-dragging');
            try { img.releasePointerCapture(e.pointerId); } catch (err) { }
        };
        const onDragStart = (e) => e.preventDefault();

        img.addEventListener('pointerdown', onPointerDown);
        img.addEventListener('pointermove', onPointerMove);
        img.addEventListener('pointerup', onPointerUp);
        img.addEventListener('pointercancel', onPointerUp);
        img.addEventListener('dragstart', onDragStart);

        const hint = document.createElement('div');
        hint.className = 'ms-pan-hint';
        hint.textContent = bridge.panWheelScroll ? 'Hand tool: drag or scroll to pan' : 'Hand tool: drag to pan';
        if (!zoomMode) {
            wrap.appendChild(hint);
            setTimeout(() => { if (hint.parentNode) hint.remove(); }, 2200);
        }

        bridge.state.pan = {
            active: true,
            img: img,
            zoomed: zoomMode,
            returnToFill: !!(opts && opts.returnToFill),
            moved: false,
            view: () => ({ x: x, y: y, dispW: dispW, dispH: dispH }),
            panBy: (dx, dy) => {
                x += dx;
                y += dy;
                scheduleClampAndApply();
            },
            updateZoom: (newScale) => {
                const cx = dispW ? (wrapW / 2 - x) / dispW : 0.5;
                const cy = dispH ? (wrapH / 2 - y) / dispH : 0.5;
                dispW = img.naturalWidth * newScale;
                dispH = img.naturalHeight * newScale;
                x = wrapW / 2 - cx * dispW;
                y = wrapH / 2 - cy * dispH;
                clampAndApply();
                if (slider) {
                    slider.value = newScale;
                    const valueEl = bridge.state.overlay ? bridge.state.overlay.querySelector('.ms-zoom-value') : null;
                    if (valueEl) valueEl.textContent = Math.round(newScale * 100) + '%';
                }
            },
            cleanup: () => {
                if (panResize) panResize.disconnect();
                if (panRaf !== null) { cancelAnimationFrame(panRaf); panRaf = null; }
                img.removeEventListener('pointerdown', onPointerDown);
                img.removeEventListener('pointermove', onPointerMove);
                img.removeEventListener('pointerup', onPointerUp);
                img.removeEventListener('pointercancel', onPointerUp);
                img.removeEventListener('dragstart', onDragStart);
                img.classList.remove('ms-pannable');
                img.style.width = '';
                img.style.height = '';
                img.style.transform = '';
                img.style.transformOrigin = '';
                img.style.removeProperty('inset');
                img.style.removeProperty('margin');
                wrap.classList.remove('ms-pan-enabled', 'ms-pan-dragging');
                if (hint.parentNode) hint.remove();
            }
        };
        updateButtons();
        return true;
    }

function shouldAutoPan(wrap, img) {
        if (!wrap || !img || !img.naturalWidth || !img.naturalHeight) return false;
        const wrapW = wrap.clientWidth;
        const wrapH = wrap.clientHeight;
        if (!wrapW || !wrapH) return false;

        if (img.naturalHeight < img.naturalWidth * 3.5) return false;
        const fillScale = Math.min(1, Math.max(wrapW / img.naturalWidth, wrapH / img.naturalHeight));
        return img.naturalHeight * fillScale > wrapH * 1.15;
    }

function togglePanMode() {
        if (!bridge.state.overlay || bridge.state.gridMode) return;
        const entry = bridge.state.items[bridge.state.currentIndex];
        const item = entry ? (entry.item || entry) : null;
        if (bridge.state.pan && bridge.state.pan.active) {
            if (item) item.msNoAutoPan = true;
            disablePan();
            updateButtons();
            return;
        }
        const wrap = bridge.state.overlay.querySelector('.ms-media-wrap');
        const img = wrap ? wrap.querySelector('img.ms-media.ms-ready') : null;
        if (wrap && img) {
            if (item) delete item.msNoAutoPan;
            enablePanForImage(wrap, img);
        }
    }

function clearFullscreenIdleTimer() {
        if (bridge.fullscreenIdleTimer) {
            clearTimeout(bridge.fullscreenIdleTimer);
            bridge.fullscreenIdleTimer = null;
        }
    }

function scheduleFullscreenIdleHide() {
        clearFullscreenIdleTimer();
        bridge.fullscreenIdleTimer = setTimeout(() => {
            if (!bridge.state.overlay || !bridge.state.stageFullscreen) return;
            if (bridge.state.overlay.querySelector('.ms-gallery-topbar:hover')) {
                scheduleFullscreenIdleHide();
                return;
            }
            bridge.state.overlay.classList.add('ms-topbar-idle');
        }, bridge.FULLSCREEN_IDLE_MS);
    }

function wakeFullscreenTopbar() {
        if (!bridge.state.overlay || !bridge.state.stageFullscreen) return;
        bridge.state.overlay.classList.remove('ms-topbar-idle');
        scheduleFullscreenIdleHide();
    }

function toggleStageFullscreen() {
        if (!bridge.state.overlay || bridge.state.gridMode) return;
        bridge.state.stageFullscreen = !bridge.state.stageFullscreen;
        bridge.state.overlay.classList.toggle('ms-stage-fullscreen', bridge.state.stageFullscreen);
        disablePan();
        updateButtons();
        if (bridge.state.stageFullscreen) {
            wakeFullscreenTopbar();
        } else {
            clearFullscreenIdleTimer();
            bridge.state.overlay.classList.remove('ms-topbar-idle');
        }
    }

function handleImageZoomClick(wrap, img, item, e) {
        if (bridge.state.pan && bridge.state.pan.moved) {
            bridge.state.pan.moved = false;
            return;
        }

        if (bridge.state.pan && bridge.state.pan.active && bridge.state.pan.zoomed) {
            const returnToFill = bridge.state.pan.returnToFill;
            disablePan();
            if (returnToFill) enablePanForImage(wrap, img);
            return;
        }

        const rect = img.getBoundingClientRect();
        if (!img.naturalWidth || !rect.width || rect.width >= img.naturalWidth) return;
        const wasFill = !!(bridge.state.pan && bridge.state.pan.active);
        const px = (e.clientX - rect.left) / rect.width;
        const py = (e.clientY - rect.top) / rect.height;
        const wrapRect = wrap.getBoundingClientRect();

        const isTallStrip = img.naturalHeight / Math.max(1, img.naturalWidth) >= 2.2;
        enablePanForImage(wrap, img, {
            zoom: true,
            initialX: (e.clientX - wrapRect.left) - px * img.naturalWidth,
            initialY: (!wasFill && isTallStrip) ? 0 : (e.clientY - wrapRect.top) - py * img.naturalHeight,
            returnToFill: wasFill
        });
    }

function createPlaceholderIcon(isVideo) {
        return globalThis.XGalleryCore.createPlaceholderIcon(document, isVideo);
    }

function getPastelColorForGroupId(groupId) {
        if (!groupId) return 'rgba(255, 255, 255, 0.25)';
        let hash = 0;
        for (let i = 0; i < groupId.length; i++) {
            hash = groupId.charCodeAt(i) + ((hash << 5) - hash);
        }
        const hue = Math.abs(hash % 360);
        return `hsl(${hue}, 35%, 85%)`;
    }

function getSourceClass(item) {
        return bridge.sourcePresentationClass(item);
    }

function promoteLazyThumbVideo(vid) {
        const url = vid && vid.dataset ? vid.dataset.msLazySrc : '';
        if (!url || vid.src) return;
        delete vid.dataset.msLazySrc;
        vid.preload = 'metadata';
        vid.src = url;
    }

function promoteLazyMp4Poster(img) {
        if (!img || img.dataset.msMp4Started) return;
        img.dataset.msMp4Started = '1';
        bridge.mp4PosterForItem(img._msPosterItem).then((dataUrl) => {
            if (!img.isConnected) return;
            img.src = dataUrl;
            img.classList.add('ms-loaded');
        }).catch(() => {
            if (typeof img._msPosterFail === 'function') img._msPosterFail();
        });
    }

function observeLazyThumb(el) {
        if (typeof IntersectionObserver === 'undefined') {
            if (el.tagName === 'VIDEO') promoteLazyThumbVideo(el);
            else promoteLazyMp4Poster(el);
            return;
        }
        if (!bridge.lazyThumbObserver) {
            bridge.lazyThumbObserver = new IntersectionObserver((entries, obs) => {
                entries.forEach((e) => {
                    if (!e.isIntersecting) return;
                    obs.unobserve(e.target);
                    if (e.target.tagName === 'VIDEO') promoteLazyThumbVideo(e.target);
                    else promoteLazyMp4Poster(e.target);
                });
            }, { rootMargin: '300px' });
        }
        bridge.lazyThumbObserver.observe(el);
    }

function createLazyThumbVideo(url, onError) {
        const vid = document.createElement('video');
        vid.preload = 'none';
        vid.muted = true;
        vid.playsInline = true;
        vid.style.cssText = 'width:100%;height:100%;object-fit:cover;pointer-events:none;display:block;background:#111;';
        vid.dataset.msLazySrc = url;
        if (onError) vid.onerror = onError;
        observeLazyThumb(vid);
        return vid;
    }

function createLazyMp4PosterImg(item, onError) {
        const img = document.createElement('img');
        img.referrerPolicy = 'no-referrer';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;pointer-events:none;display:block;background:#111;';
        img.dataset.msLazyMp4 = '1';
        img._msPosterItem = item;
        img._msPosterFail = onError;
        observeLazyThumb(img);
        return img;
    }

function appendVideoThumbMedia(host, item, thumbSrc, isVideo, placeholderClass) {
        if (bridge.reservedPostHeader) {
            host.classList.add(placeholderClass);
            host.appendChild(createPlaceholderIcon(true));
            return;
        }
        const fail = function (el) {
            if (el.parentNode === host && !host.classList.contains(placeholderClass)) {
                host.classList.add(placeholderClass);
                host.innerHTML = '';
                host.appendChild(createPlaceholderIcon(isVideo));
            }
        };
        if (item._frozenThumb) {
            const img = document.createElement('img');
            img.referrerPolicy = 'no-referrer';
            img.src = item._frozenThumb;
            img.classList.add('ms-loaded');
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;pointer-events:none;display:block;background:#111;';
            host.appendChild(img);
            return;
        }
        if (bridge.isMp4ThumbUrl(item.src || thumbSrc) && bridge.msMp4Box()) {
            const img = createLazyMp4PosterImg(item, function () { fail(img); });
            host.appendChild(img);
            return;
        }
        const vid = createLazyThumbVideo(
            thumbSrc.includes('#t=') ? thumbSrc : (thumbSrc + '#t=0.1'),
            function () { fail(vid); });
        host.appendChild(vid);
    }

function stopThumbTrackAnimation() {
        if (bridge.state.thumbScrollRaf === null) return;
        cancelAnimationFrame(bridge.state.thumbScrollRaf);
        bridge.state.thumbScrollRaf = null;
    }

function animateThumbTrackTo(track, target) {
        stopThumbTrackAnimation();
        const start = track.scrollLeft;
        const distance = target - start;
        const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reducedMotion || Math.abs(distance) < 1) {
            track.scrollLeft = target;
            return;
        }
        const started = bridge.performance.now();
        const duration = Math.min(180, 110 + Math.abs(distance) / 8);
        const step = (now) => {
            const progress = Math.min(1, (now - started) / duration);
            const eased = 1 - Math.pow(1 - progress, 3);
            track.scrollLeft = start + distance * eased;
            if (progress < 1) bridge.state.thumbScrollRaf = requestAnimationFrame(step);
            else bridge.state.thumbScrollRaf = null;
        };
        bridge.state.thumbScrollRaf = requestAnimationFrame(step);
    }

function setActiveThumb(thumbs, scroll) {
        if (!bridge.state.overlay) return;
        if (scroll) {
            bridge.state.thumbsFollowCenter = true;
            syncThumbsWindow({ center: true });
        }
        const track = bridge.state.overlay.querySelector('.ms-thumbs-track');
        if (!track) return;
        const activeThumb = track.querySelector('.ms-thumb[data-index="' + bridge.state.currentIndex + '"]');
        const prev = track.querySelector('.ms-thumb.active');
        if (prev && prev !== activeThumb) prev.classList.remove('active');
        if (activeThumb) activeThumb.classList.add('active');
    }

function thumbStripCenterTarget(track, index) {
        const n = bridge.state.items.length;
        if (!track || !n) return 0;
        const sizer = track.querySelector('.ms-thumbs-sizer');
        const width = track.clientWidth;
        const span = (sizer && sizer.offsetWidth) || (n * bridge.MS_THUMB_STRIDE);
        const maxScroll = Math.max(0, span - width);
        return Math.max(0, Math.min(maxScroll, index * bridge.MS_THUMB_STRIDE - width / 2 + bridge.MS_THUMB_STRIDE / 2));
    }

function applyThumbStripCenter(track, animate) {
        if (!track) return;
        if (!track.clientWidth) {
            if (bridge.state.thumbsCenterRetry) return;
            bridge.state.thumbsCenterRetry = requestAnimationFrame(() => {
                bridge.state.thumbsCenterRetry = null;
                if (!bridge.state.overlay) return;
                const next = bridge.state.overlay.querySelector('.ms-thumbs-track');
                if (next && next.clientWidth) applyThumbStripCenter(next, false);
            });
            return;
        }
        const target = thumbStripCenterTarget(track, bridge.state.currentIndex);
        if (animate) animateThumbTrackTo(track, target);
        else {
            stopThumbTrackAnimation();
            if (Math.abs(track.scrollLeft - target) >= 1) track.scrollLeft = target;
        }
    }

function thumbSourceClass(item) {
        return getSourceClass(item);
    }

function thumbItemKey(entry) {
        const item = entry && (entry.item || entry);
        if (!item) return '';
        return String(bridge.mediaKey(item));
    }

function resetMediaThumbEl(el) {
        if (!el) return;
        const vid = el.querySelector('video');
        if (vid) {
            try {
                vid.pause();
                vid.removeAttribute('src');
                vid.load();
            } catch (e) { }
            if (typeof bridge.lazyThumbObserver !== 'undefined' && bridge.lazyThumbObserver) {
                try { bridge.lazyThumbObserver.unobserve(vid); } catch (e) { }
            }
        }
        el.innerHTML = '';
        el.removeAttribute('data-hd-src');
        delete el.dataset.msKey;
    }

function onWindowedThumbClick(e) {
        if (bridge.state.dragData && bridge.state.dragData.justDragged) {
            bridge.state.dragData.justDragged = false;
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        const btn = e.currentTarget;
        const index = parseInt(btn.getAttribute('data-index'), 10);
        if (!Number.isFinite(index) || index < 0 || index >= bridge.state.items.length) return;
        e.preventDefault();
        e.stopPropagation();
        bridge.rememberNavigationDirection(bridge.state.currentIndex, index, bridge.state.items.length);
        bridge.state.currentIndex = index;
        const entry = bridge.state.items[index];
        if (entry && entry.node) bridge.state.activeNode = entry.node;
        bridge.renderCurrent();
    }

function onWindowedGridClick(e) {
        const cell = e.currentTarget;
        const index = parseInt(cell.getAttribute('data-grid-index'), 10);
        if (!Number.isFinite(index) || index < 0 || index >= bridge.state.items.length) return;
        e.preventDefault();
        e.stopPropagation();
        bridge.rememberNavigationDirection(bridge.state.currentIndex, index, bridge.state.items.length);
        bridge.state.currentIndex = index;
        const entry = bridge.state.items[index];
        if (entry && entry.node) bridge.state.activeNode = entry.node;
        setGridMode(false);
    }

function fillThumbButton(btn, entry, index, groupCounts) {
        resetMediaThumbEl(btn);
        const item = entry.item || entry;
        const thumbSrc = item.thumbSrc || item.src;
        const hdSrc = bridge.getHdSrc(item);
        if (hdSrc) btn.setAttribute('data-hd-src', hdSrc);
        const cacheClass = (hdSrc && !bridge.state.cachedImageUrls.has(hdSrc) && !item._msMediaLoaded) ? ' ms-uncached' : '';
        const isVideo = item.type === 'video' || item.type === 'iframe' || item.expectedVideo || item.xUnplayable;
        const hasPoster = !!(item.thumbSrc && item.thumbSrc !== item.src && !bridge.isPlaceholderUrl(item.thumbSrc));
        const isPlaceholder = bridge.isPlaceholderUrl(thumbSrc) || (isVideo && !hasPoster && !bridge.canExtractMp4Poster(item, thumbSrc));
        btn.setAttribute('data-index', String(index));
        btn.dataset.msKey = thumbItemKey(entry);
        btn.style.display = '';
        btn.style.left = (index * bridge.MS_THUMB_STRIDE) + 'px';
        btn.style.boxShadow = '';
        const animated = bridge.isFreezableAnimatedThumb(item);
        globalThis.XGalleryCore.renderThumbnailCell({
            document: document,
            host: btn,
            baseClass: 'ms-thumb',
            absoluteClass: ' ms-thumb-abs',
            placeholderClass: 'ms-placeholder',
            sourceClass: thumbSourceClass(item),
            cacheClass: cacheClass,
            active: index === bridge.state.currentIndex,
            hdSrc: hdSrc,
            isVideo: isVideo,
            isAnimated: animated,
            animatedLabel: animated ? bridge.animatedThumbLabel(item) : '',
            isPlaceholder: isPlaceholder,
            isVideoThumb: isVideo && !hasPoster &&
                (bridge.isVideoThumbSource(thumbSrc) || !bridge.isImageThumbSource(thumbSrc)),
            sourceUrl: item.src,
            appendVideo: (host) => appendVideoThumbMedia(host, item, thumbSrc, isVideo, 'ms-placeholder'),
            loadImage: (img) => {
                if (animated) {
                    img.src = thumbSrc;
                    bridge.freezeAnimatedThumbnail(img, item);
                } else {
                    bridge.setCachedImgSrc(img, thumbSrc);
                }
            }
        });
    }

function invalidateThumbGroupData() {
        bridge.state.thumbGroupData = null;
    }

function thumbGroupData() {
        const cached = bridge.state.thumbGroupData;
        if (cached && cached.items === bridge.state.items && cached.length === bridge.state.items.length) return cached;
        const counts = new Map();
        const runs = [];
        bridge.state.items.forEach((entry) => {
            const it = entry.item || entry;
            const gid = it.groupId || '';
            if (!gid) return;
            const extra = bridge.extraMediaCount(it);
            counts.set(gid, (counts.get(gid) || 0) + 1 + extra);
        });
        let start = 0;
        while (start < bridge.state.items.length) {
            const gid = (bridge.state.items[start].item || bridge.state.items[start]).groupId || '';
            let end = start + 1;
            while (end < bridge.state.items.length && ((bridge.state.items[end].item || bridge.state.items[end]).groupId || '') === gid) end++;
            if (gid && (counts.get(gid) || 0) > 1) runs.push({ gid: gid, start: start, end: end });
            start = end;
        }
        bridge.state.thumbGroupData = { items: bridge.state.items, length: bridge.state.items.length, counts: counts, runs: runs };
        return bridge.state.thumbGroupData;
    }

function thumbsGroupCounts() {
        return thumbGroupData().counts;
    }

function ensureThumbsWindow(track) {
        if (!track.classList.contains('ms-thumbs-windowed')) {
            track.classList.add('ms-thumbs-windowed');
            track.innerHTML = '';
            bridge.state.thumbsPool = [];
            const sizer = document.createElement('div');
            sizer.className = 'ms-thumbs-sizer';
            track.appendChild(sizer);
            track.addEventListener('scroll', onThumbsWindowScroll, { passive: true });
            enableThumbDragScroll(track);
        }
        let sizer = track.querySelector('.ms-thumbs-sizer');
        if (!sizer) {
            sizer = document.createElement('div');
            sizer.className = 'ms-thumbs-sizer';
            track.insertBefore(sizer, track.firstChild);
        }
        return sizer;
    }

function onThumbsWindowScroll() {
        if (bridge.state.thumbsWindowRaf) return;
        bridge.state.thumbsWindowRaf = requestAnimationFrame(() => {
            bridge.state.thumbsWindowRaf = null;
            if (!bridge.state.overlay) return;
            const track = bridge.state.overlay.querySelector('.ms-thumbs-track');
            if (track) paintThumbsWindow(track, thumbGroupData());
        });
    }

function takePoolCell(pool, used, key) {
        if (key) {
            for (let i = 0; i < pool.length; i++) {
                if (!used.has(pool[i]) && pool[i].dataset.msKey === key) return pool[i];
            }
        }
        for (let i = 0; i < pool.length; i++) {
            if (!used.has(pool[i])) return pool[i];
        }
        return null;
    }

function paintThumbsWindow(track, groupData) {
        const data = groupData || thumbGroupData();
        const groupCounts = data.counts;
        const n = bridge.state.items.length;
        const pad = 6;
        const start = Math.max(0, Math.floor(track.scrollLeft / bridge.MS_THUMB_STRIDE) - pad);
        const vis = Math.ceil(Math.max(track.clientWidth, 1) / bridge.MS_THUMB_STRIDE) + pad * 2;
        const end = Math.min(n, start + vis);
        const want = Math.max(0, end - start);
        if (!bridge.state.thumbsPool) bridge.state.thumbsPool = [];
        const pool = bridge.state.thumbsPool;
        const used = new Set();
        for (let index = start; index < end; index++) {
            const entry = bridge.state.items[index];
            const key = thumbItemKey(entry);
            let btn = takePoolCell(pool, used, key);
            if (!btn) {
                btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'ms-thumb ms-thumb-abs';
                btn.addEventListener('click', onWindowedThumbClick);
                track.appendChild(btn);
                pool.push(btn);
            }
            used.add(btn);
            btn.style.display = '';
            btn.style.left = (index * bridge.MS_THUMB_STRIDE) + 'px';
            if (btn.dataset.msKey === key) {
                btn.setAttribute('data-index', String(index));
                btn.classList.toggle('active', index === bridge.state.currentIndex);
                continue;
            }
            fillThumbButton(btn, entry, index, groupCounts);
        }
        for (let i = 0; i < pool.length; i++) {
            if (used.has(pool[i])) continue;
            pool[i].style.display = 'none';
            pool[i].removeAttribute('data-index');
        }
        while (pool.length > want + 8) {
            const extra = pool.pop();
            try { extra.remove(); } catch (e) { }
        }
        paintThumbGroupOutlines(track, data, start, end);
        paintLoadMarks(track, start, end);
    }

function paintLoadMarks(track, visibleStart, visibleEnd) {
        let layer = track.querySelector('.ms-load-mark-layer');
        if (!layer) {
            layer = document.createElement('div');
            layer.className = 'ms-load-mark-layer';
            track.appendChild(layer);
        }
        const n = bridge.state.items.length;
        layer.style.width = Math.max(0, n * bridge.MS_THUMB_STRIDE) + 'px';
        layer.innerHTML = '';
        if (!bridge.galleryLoadMarks.length) return;
        const start = Math.max(0, Number.isFinite(visibleStart) ? visibleStart : 0);
        const end = Math.min(n, Number.isFinite(visibleEnd) ? visibleEnd : n);
        for (let m = 0; m < bridge.galleryLoadMarks.length; m++) {
            const atSrc = bridge.galleryLoadMarks[m];
            let index = -1;
            for (let i = 0; i < n; i++) {
                const it = bridge.state.items[i].item || bridge.state.items[i];
                if (it && it.src === atSrc) { index = i; break; }
            }
            if (index < 1) continue;
            if (index < start || index > end) continue;
            const mark = document.createElement('div');
            mark.className = 'ms-load-mark';
            mark.title = 'Loaded more';
            mark.style.left = (index * bridge.MS_THUMB_STRIDE - 14) + 'px';
            mark.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 1.5 8.5 6l-5 4.5"/></svg>';
            layer.appendChild(mark);
        }
    }

function paintThumbGroupOutlines(track, groupData, visibleStart, visibleEnd) {
        let layer = track.querySelector('.ms-thumb-group-layer');
        if (!layer) {
            layer = document.createElement('div');
            layer.className = 'ms-thumb-group-layer';
            track.appendChild(layer);
        }
        layer.innerHTML = '';
        const data = groupData || thumbGroupData();
        const runs = data.runs;
        const start = Math.max(0, Number.isFinite(visibleStart) ? visibleStart : 0);
        const end = Math.min(bridge.state.items.length, Number.isFinite(visibleEnd) ? visibleEnd : bridge.state.items.length);
        let low = 0;
        let high = runs.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (runs[mid].end <= start) low = mid + 1;
            else high = mid;
        }
        for (let r = low; r < runs.length && runs[r].start < end; r++) {
            const run = runs[r];
            const box = document.createElement('div');
            box.className = 'ms-thumb-group-box';

            box.style.left = (run.start * bridge.MS_THUMB_STRIDE - 2) + 'px';
            box.style.width = ((run.end - run.start) * bridge.MS_THUMB_STRIDE - 2) + 'px';
            box.style.borderColor = getPastelColorForGroupId(run.gid);
            layer.appendChild(box);
        }
    }

function syncThumbsWindow(opts) {
        if (!bridge.state.overlay) return;
        const track = bridge.state.overlay.querySelector('.ms-thumbs-track');
        if (!track) return;
        const sizer = ensureThumbsWindow(track);
        const n = bridge.state.items.length;
        const prevIndex = bridge.state.thumbsPaintIndex;
        sizer.style.width = Math.max(0, n * bridge.MS_THUMB_STRIDE) + 'px';
        if (opts && opts.center) bridge.state.thumbsFollowCenter = true;
        if (bridge.state.thumbsFollowCenter && n) {
            applyThumbStripCenter(track, !!(opts && opts.center));
        } else if (typeof prevIndex === 'number' && prevIndex !== bridge.state.currentIndex) {
            stopThumbTrackAnimation();
            track.scrollLeft += (bridge.state.currentIndex - prevIndex) * bridge.MS_THUMB_STRIDE;
        }
        bridge.state.thumbsPaintIndex = bridge.state.currentIndex;
        paintThumbsWindow(track, thumbGroupData());
    }

function gridMetrics(wrap, grid) {
        const size = (typeof bridge.gridThumbSize === 'number' && bridge.gridThumbSize) ? bridge.gridThumbSize : 160;
        const gap = 8;
        let innerW = grid && grid.clientWidth;
        if (!innerW && wrap) {
            const cs = window.getComputedStyle(wrap);
            innerW = wrap.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
        }
        innerW = Math.max(1, innerW || 1);
        const cols = Math.max(1, Math.floor((innerW + gap) / (size + gap)));
        const cell = (innerW - (cols - 1) * gap) / cols;
        return { cols: cols, cell: cell, gap: gap, rowH: cell + gap };
    }

function ensureGridWindow(grid, wrap) {
        if (!grid.classList.contains('ms-grid-windowed')) {
            grid.classList.add('ms-grid-windowed');
            grid.innerHTML = '';
            bridge.state.gridPool = [];
            const sizer = document.createElement('div');
            sizer.className = 'ms-grid-sizer';
            grid.appendChild(sizer);
            if (wrap && wrap.dataset.msGridWindow !== '1') {
                wrap.dataset.msGridWindow = '1';
                wrap.addEventListener('scroll', onGridWindowScroll, { passive: true });
                if (typeof ResizeObserver !== 'undefined') {
                    const ro = new ResizeObserver(() => {
                        if (bridge.state.gridMode) syncGridWindow();
                    });
                    ro.observe(wrap);
                    bridge.state.gridResizeObs = ro;
                }
            }
        }
        let sizer = grid.querySelector('.ms-grid-sizer');
        if (!sizer) {
            sizer = document.createElement('div');
            sizer.className = 'ms-grid-sizer';
            grid.insertBefore(sizer, grid.firstChild);
        }
        return sizer;
    }

function onGridWindowScroll() {
        if (bridge.state.gridWindowRaf) return;
        bridge.state.gridWindowRaf = requestAnimationFrame(() => {
            bridge.state.gridWindowRaf = null;
            if (!bridge.state.overlay || !bridge.state.gridMode) return;
            paintGridWindow();
        });
    }

function paintGridWindow() {
        if (!bridge.state.overlay) return;
        const grid = bridge.state.overlay.querySelector('.ms-grid');
        const wrap = bridge.state.overlay.querySelector('.ms-grid-wrap');
        if (!grid || !wrap) return;
        const sizer = ensureGridWindow(grid, wrap);
        const n = bridge.state.items.length;
        const m = gridMetrics(wrap, grid);
        const rows = Math.ceil(n / m.cols);
        sizer.style.height = Math.max(0, rows * m.rowH - m.gap) + 'px';
        const pad = 2;
        const startRow = Math.max(0, Math.floor(wrap.scrollTop / m.rowH) - pad);
        const visRows = Math.ceil(Math.max(wrap.clientHeight, 1) / m.rowH) + pad * 2;
        const start = startRow * m.cols;
        const end = Math.min(n, (startRow + visRows) * m.cols);
        const want = Math.max(0, end - start);
        if (!bridge.state.gridPool) bridge.state.gridPool = [];
        const pool = bridge.state.gridPool;
        const used = new Set();
        for (let index = start; index < end; index++) {
            const entry = bridge.state.items[index];
            const key = thumbItemKey(entry);
            const col = index % m.cols;
            const row = Math.floor(index / m.cols);
            let cell = takePoolCell(pool, used, key);
            if (!cell) {
                cell = document.createElement('button');
                cell.type = 'button';
                cell.className = 'ms-grid-cell ms-grid-abs';
                cell.addEventListener('click', onWindowedGridClick);
                grid.appendChild(cell);
                pool.push(cell);
            }
            used.add(cell);
            cell.style.display = '';
            cell.style.width = m.cell + 'px';
            cell.style.height = m.cell + 'px';
            cell.style.left = (col * (m.cell + m.gap)) + 'px';
            cell.style.top = (row * m.rowH) + 'px';
            if (cell.dataset.msKey === key) {
                cell.setAttribute('data-grid-index', String(index));
                cell.classList.toggle('active', index === bridge.state.currentIndex);
                continue;
            }
            fillGridCell(cell, entry, index);
        }
        for (let i = 0; i < pool.length; i++) {
            if (used.has(pool[i])) continue;
            pool[i].style.display = 'none';
            pool[i].removeAttribute('data-grid-index');
        }
    }

function fillGridCell(cell, entry, index) {
        resetMediaThumbEl(cell);
        const item = entry.item || entry;
        const hdSrc = bridge.getHdSrc(item);
        if (hdSrc) cell.setAttribute('data-hd-src', hdSrc);
        const cacheClass = (hdSrc && !bridge.state.cachedImageUrls.has(hdSrc) && !item._msMediaLoaded) ? ' ms-uncached' : '';
        cell.setAttribute('data-grid-index', String(index));
        cell.dataset.msKey = thumbItemKey(entry);
        const thumbSrc = item.thumbSrc || item.src;
        const isVideo = item.type === 'video' || item.type === 'iframe' || item.expectedVideo || item.xUnplayable;
        const hasPoster = !!(item.thumbSrc && item.thumbSrc !== item.src && !bridge.isPlaceholderUrl(item.thumbSrc));
        const animated = bridge.isFreezableAnimatedThumb(item);
        globalThis.XGalleryCore.renderThumbnailCell({
            document: document,
            host: cell,
            baseClass: 'ms-grid-cell',
            absoluteClass: ' ms-grid-abs',
            placeholderClass: 'ms-grid-placeholder',
            cacheClass: cacheClass,
            active: index === bridge.state.currentIndex,
            hdSrc: hdSrc,
            isVideo: isVideo,
            isAnimated: animated,
            animatedLabel: animated ? bridge.animatedThumbLabel(item) : '',
            isPlaceholder: bridge.isPlaceholderUrl(thumbSrc) ||
                (isVideo && !hasPoster && !bridge.canExtractMp4Poster(item, thumbSrc)),
            isVideoThumb: isVideo && !hasPoster &&
                (bridge.isVideoThumbSource(thumbSrc) || !bridge.isImageThumbSource(thumbSrc)),
            sourceUrl: item.src,
            appendVideo: (host) => appendVideoThumbMedia(host, item, thumbSrc, isVideo, 'ms-grid-placeholder'),
            loadImage: (img) => {
                if (animated) {
                    img.src = thumbSrc;
                    bridge.freezeAnimatedThumbnail(img, item);
                } else {
                    bridge.setCachedImgSrc(img, thumbSrc);
                }
            },
            indexLabel: index + 1
        });
    }

function syncGridWindow() {
        paintGridWindow();
    }

function renderThumbs() {
        bridge.syncCoreItems('thumb-render');
        invalidateThumbGroupData();
        syncThumbsWindow();
    }

function updateSingleThumb(index, entry) {
        if (!bridge.state.overlay) return;
        const track = bridge.state.overlay.querySelector('.ms-thumbs-track');
        if (!track) return;
        const btn = track.querySelector('[data-index="' + index + '"]');
        if (!btn) return;
        fillThumbButton(btn, entry, index, thumbsGroupCounts());
    }

function markItemMediaLoaded(item) {
        if (!item || !bridge.state.overlay) return;
        item._msMediaLoaded = true;
        const index = bridge.state.items.findIndex((entry) => (entry.item || entry) === item);
        if (index < 0) return;

        const track = bridge.state.overlay.querySelector('.ms-thumbs-track');
        let thumb = track ? track.querySelector('[data-index="' + index + '"]') : null;
        const thumbSrc = item.thumbSrc || '';
        if (thumb && thumb.classList.contains('ms-placeholder') && thumbSrc && !bridge.isPlaceholderUrl(thumbSrc)) {
            updateSingleThumb(index, bridge.state.items[index]);
            thumb = track.querySelector('[data-index="' + index + '"]');
        }
        if (thumb) {
            thumb.classList.remove('ms-uncached', 'ms-media-error');
            thumb.classList.add('ms-media-loaded');
        }

        const gridCell = bridge.state.overlay.querySelector('[data-grid-index="' + index + '"]');
        if (gridCell) {
            gridCell.classList.remove('ms-uncached', 'ms-media-error');
            gridCell.classList.add('ms-media-loaded');
        }
    }

function enableThumbDragScroll(track) {
        if (bridge.state.thumbDragBound) return;
        bridge.state.thumbDragBound = true;

        const onDown = (clientX) => {
            stopThumbTrackAnimation();
            bridge.state.thumbsFollowCenter = false;
            bridge.state.dragData = {
                startX: clientX,
                startScroll: track.scrollLeft,
                moved: false,
                mouseDown: true,
                justDragged: false
            };
        };

        const onMove = (clientX) => {
            if (!bridge.state.dragData || !bridge.state.dragData.mouseDown) return;
            const dx = clientX - bridge.state.dragData.startX;
            if (Math.abs(dx) > 4) {
                bridge.state.dragData.moved = true;
                bridge.state.dragData.justDragged = true;
            }
            track.scrollLeft = bridge.state.dragData.startScroll - dx;
        };

        const onUp = () => {
            if (!bridge.state.dragData) return;
            bridge.state.dragData.mouseDown = false;
            if (bridge.state.dragData.justDragged) {
                setTimeout(() => {
                    if (bridge.state.dragData) bridge.state.dragData.justDragged = false;
                }, 0);
            }
        };

        const onWindowMove = (e) => onMove(e.clientX);
        const endDrag = () => {
            window.removeEventListener('mousemove', onWindowMove);
            onUp();
        };
        track.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            onDown(e.clientX);
            window.addEventListener('mousemove', onWindowMove);
            window.addEventListener('mouseup', endDrag, { once: true });
        });

        track.addEventListener('touchstart', (e) => {
            const t = e.touches && e.touches[0];
            if (!t) return;
            onDown(t.clientX);
        }, { passive: true });
        track.addEventListener('touchmove', (e) => {
            const t = e.touches && e.touches[0];
            if (!t) return;
            onMove(t.clientX);
        }, { passive: true });
        track.addEventListener('touchend', onUp, { passive: true });
        track.addEventListener('touchcancel', onUp, { passive: true });
    }

function appendErrorBanner(container, errMsg) {
        globalThis.XGalleryCore.renderErrorBanner({
            document: document,
            container: container,
            message: errMsg
        });
    }

function renderErrorStage(container, errMsg, url, item) {
        globalThis.XGalleryCore.renderErrorStage({
            document: document,
            container: container,
            message: errMsg,
            url: url,
            canRetry: !!(item && (item.resolveUrl || item.src)),
            onRetry: () => {
                const resolveUrl = item.resolveUrl || item.src;
                if (resolveUrl) {
                    bridge.resolvedFileUrlCache.delete(resolveUrl);
                    bridge.resolvingFileUrlCache.delete(resolveUrl);
                }
                item.needsResolve = true;
                delete item.error;
                bridge.renderCurrent();
            }
        });
    }

function prepareMediaWrap(wrap, item) {
        return globalThis.XGalleryCore.prepareMediaSlot({
            document: document,
            wrap: wrap,
            item: item
        });
    }

function bindGlobalGalleryHandlers() {
        if (bridge.state.keyHandler) return;

        bridge.state.keyHandler = function (e) {
            if (!bridge.state.open) return;
            if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
                e.preventDefault();
                if (bridge.state.filterBar && typeof bridge.state.filterBar.focus === 'function') bridge.state.filterBar.focus();
                return;
            }
            if (e.key === 'Escape' && bridge.state.filterBar && bridge.state.filterBar.isOpen && bridge.state.filterBar.isOpen()) {
                e.preventDefault();
                bridge.state.filterBar.close();
                const focusRoot = bridge.state.overlay && bridge.state.overlay.getRootNode && bridge.state.overlay.getRootNode();
                const focused = (focusRoot && focusRoot.activeElement) || document.activeElement;
                if (focused && typeof focused.blur === 'function') focused.blur();
                return;
            }
            const activeRoot = bridge.state.overlay && bridge.state.overlay.getRootNode && bridge.state.overlay.getRootNode();
            const active = (activeRoot && activeRoot.activeElement) || document.activeElement;
            if (active && (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || active.isContentEditable)) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                if (!bridge.state.gridMode && bridge.state.cameFromGrid) {
                    setGridMode(true);
                } else {
                    bridge.closeGallery();
                }
            } else if (e.key === 'g' || e.key === 'G') {
                e.preventDefault();
                setGridMode(!bridge.state.gridMode);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                if (!bridge.state.gridMode) bridge.navigate(1);
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                if (!bridge.state.gridMode) bridge.navigate(-1);
            }
        };

        window.addEventListener('keydown', bridge.state.keyHandler, { capture: true });
    }

function unbindGlobalGalleryHandlers() {
        if (bridge.state.keyHandler) {
            window.removeEventListener('keydown', bridge.state.keyHandler, { capture: true });
            bridge.state.keyHandler = null;
        }
    }

function closeGallerySettings(overlay) {
        if (!overlay || overlay.dataset.msClosing === '1') return;
        overlay.dataset.msClosing = '1';
        overlay.classList.remove('ms-settings-open');
        const finish = () => { if (overlay.parentNode) overlay.remove(); };
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            finish();
            return;
        }
        let done = false;
        const end = () => { if (done) return; done = true; finish(); };
        overlay.addEventListener('transitionend', end);
        setTimeout(end, 280);
    }

function openInGalleryButtonHtml() {
        return '<span class="ms-btn-label">Open in Gallery</span>'
            + '<svg viewBox="0 0 16 16" aria-hidden="true">'
            + '<path d="M6 3.5h6.5V10M12.5 3.5 3.5 12.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
            + '</svg>';
    }

function createOpenInGalleryButton(startNode, variant) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ms-btn ms-open-in-gallery' + (variant ? ' ms-open-in-gallery--' + variant : '') +
            (variant === 'unfurl' ? ' fauxBlockLink-link' : '');
        btn.setAttribute('aria-label', 'Open in Gallery');
        btn.innerHTML = openInGalleryButtonHtml();
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            bridge.launchGallery(startNode, { fromChrome: true });
        });
        btn.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            e.stopImmediatePropagation();
        });
        return btn;
    }
function renderCurrent() {
        if (!bridge.state.overlay || !bridge.state.items.length) return;
        if (bridge.state.gridMode) return;
        bridge.syncCoreCurrent();
        bridge.checkTriggerInfiniteScroll();
        bridge.scheduleWindowResolution();
        disablePan();

        setTopbarLoading(false);
        bridge.state.hdUpgradeRun = null;
        updateHdButton('hidden');
        const token = ++bridge.state.renderToken;
        let entry = bridge.state.items[bridge.state.currentIndex];
        if (!entry) return;

        if (bridge.extraMediaCount(entry.item)) {
            bridge.expandResolvedEntry(entry);
            entry = bridge.state.items[bridge.state.currentIndex] || entry;
        }
        const item = entry.item;
        const presentation = bridge.mediaPresentation(item);

        const wrap = bridge.state.overlay.querySelector('.ms-media-wrap');
        const info = bridge.state.overlay.querySelector('.ms-gallery-info');
        const counter = bridge.state.overlay.querySelector('.ms-counter');
        const prevBtn = bridge.state.overlay.querySelector('.ms-nav.prev');
        const nextBtn = bridge.state.overlay.querySelector('.ms-nav.next');
        const thumbs = bridge.state.overlay.querySelectorAll('.ms-thumb');
        prepareMediaWrap(wrap, item);
        const buildInfoHtml = () => {
            const linkUrl = item ? (item.resolveUrl || item.src || '') : '';
            if (item && item.error) {
                return `<span style="color: #f43f5e;"><a href="${linkUrl}" target="_blank" rel="noopener noreferrer">Error: ${item.error} (${linkUrl})</a></span>`;
            }

            const author = presentation.author;
            if (author && (author.name || author.handle)) {
                const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                const avatar = author.avatarUrl
                    ? `<img class="ms-info-avatar" src="${esc(author.avatarUrl)}" referrerpolicy="no-referrer" alt="">`
                    : '';
                const who = `<a class="ms-info-author" href="${esc(author.profileUrl || linkUrl)}" target="_blank" rel="noopener noreferrer" title="${esc(author.handle || author.name)}">${esc(author.name || author.handle)}</a>`;
                return `<span class="ms-info-byline">${avatar}${who}<span class="ms-info-sep">:</span>` +
                    `<a href="${esc(linkUrl)}" target="_blank" rel="noopener noreferrer">${esc(linkUrl)}</a></span>`;
            }

            if (item && item.galleryName) {
                const escG = (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                const galleryHref = item.galleryUrl || linkUrl;
                return `<a class="ms-info-author" href="${escG(galleryHref)}" target="_blank" rel="noopener noreferrer" title="${escG(item.galleryName)}">${escG(item.galleryName)}</a>`;
            }

            return `<span style="color: var(--ms-text-2);"><a href="${linkUrl}" target="_blank" rel="noopener noreferrer">${linkUrl}</a></span>`;
        };

        if (item && item.type === 'iframe') bridge.state.overlay.classList.add('ms-iframe-nav-safe');
        else bridge.state.overlay.classList.remove('ms-iframe-nav-safe');

        if (item && item.needsResolve) {
            if (item.thumbSrc && !bridge.isPlaceholderUrl(item.thumbSrc)) {
                const thumbImg = globalThis.XGalleryCore.createLoadingPreview({
                    document: document,
                    src: item.thumbSrc,
                    onLoad: (image) => {
                        if (image.isConnected) syncVerticalFitMediaBox(image);
                    }
                });
                ensureMediaBox(wrap).appendChild(thumbImg);
                if (thumbImg.complete) syncVerticalFitMediaBox(thumbImg);
            }

            const loadingOverlay = globalThis.XGalleryCore.createResolveIndicator(document);
            wrap.appendChild(loadingOverlay);

            bridge.queueResolve(item.resolveUrl, item.expectedVideo).then((resolved) => {

                if (resolved === bridge.RESOLVE_CANCELLED) return;
                let splicedExtras = false;
                if (resolved && resolved.src) {
                    item.src = resolved.src;
                    item.type = resolved.type || (resolved.isVideo ? 'video' : 'img');
                    if (resolved.thumbSrc) item.thumbSrc = resolved.thumbSrc;
                    item.embedSrc = resolved.embedSrc || item.embedSrc;
                    if (typeof resolved.isFavorited === 'boolean') {
                        item.isFavorited = resolved.isFavorited;
                    }
                    item.error = resolved.error || null;
                    if (item.type === 'video') {
                        item.fallbackSrc = resolved.src;

                        bridge.prepareResolvedVideo(item, resolved);
                    }

                    splicedExtras = bridge.spliceResolvedExtras(entry, resolved);
                } else {
                    item.error = (resolved && resolved.error) || "Resolution failed. CORS or invalid link.";
                    if (item.fallbackSrc) {

                        item.src = item.fallbackSrc;
                    }
                }
                item.needsResolve = false;
                if (splicedExtras) return;

                const resolvedIndex = bridge.state.items.findIndex((candidate) => candidate === entry || candidate.item === item);
                if (resolvedIndex !== -1) updateSingleThumb(resolvedIndex, entry);

                if (token === bridge.state.renderToken) {
                    renderCurrent();
                }
            });

            let domain = '';
            try {
                if (item.resolveUrl) {
                    const parsedUrl = new URL(item.resolveUrl);
                    domain = parsedUrl.hostname.replace('www.', '');
                }
            } catch (e) {
                domain = 'unknown';
            }
            info.innerHTML = buildInfoHtml();
            if (counter) {
                const position = bridge.galleryPositionSnapshot();
                counter.textContent = (position.currentIndex + 1) + ' / ' + position.length;
            }
            updatePositionControl();
            const singleItem = bridge.state.items.length <= 1;
            prevBtn.disabled = singleItem;
            nextBtn.disabled = singleItem;
            setActiveThumb(thumbs, true);
            return;
        }

        if (item.type === 'img') {
            const thumbSrc = item.thumbSrc || '';
            if (bridge.isItemGif(item)) showStageNotice(wrap, 'Loading GIF...');

            const candidates = [item.src];
            if (Array.isArray(item.altSrcs)) {
                item.altSrcs.forEach((s) => {
                    if (s && candidates.indexOf(s) === -1) candidates.push(s);
                });
            }
            const wrappedSrc = bridge.wrapMediaUrl(item.src);
            if (wrappedSrc !== item.src && candidates.indexOf(wrappedSrc) === -1) candidates.push(wrappedSrc);

            const startUpgrade = (img, force) => {
                const setHd = (status) => { if (token === bridge.state.renderToken) updateHdButton(status); };
                const spinnerOff = () => { if (token === bridge.state.renderToken) setTopbarLoading(false); };
                if (!Array.isArray(item.upgradeSrcs) || !item.upgradeSrcs.length) {

                    setHd((item.atMaxRes || item.xAtMaxRes) ? 'max' : 'hidden');
                    spinnerOff();
                    return;
                }
                if (item.upgradeSrcs.indexOf(item.src) !== -1) {
                    item.upgradeSrcs = null;
                    setHd('max');
                    spinnerOff();
                    return;
                }
                if (!force && bridge.hdMode === 'off') {
                    setHd('hidden');
                    spinnerOff();
                    return;
                }
                if (!force && bridge.hdMode === 'manual') {
                    bridge.state.hdUpgradeRun = () => startUpgrade(img, true);
                    setHd('ready');
                    spinnerOff();
                    return;
                }
                if (token === bridge.state.renderToken) setTopbarLoading(true);
                setHd('loading');
                const upgrades = item.upgradeSrcs.slice();
                const tryUpgrade = (i) => {
                    if (i >= upgrades.length) {
                        item.upgradeSrcs = null;
                        setHd('hidden');
                        spinnerOff();
                        return;
                    }

                    const cooldown = bridge.hostCooldownRemaining(upgrades[i]);
                    if (cooldown > 500) {
                        if (i + 1 < upgrades.length) {
                            setTimeout(() => {
                                if (token === bridge.state.renderToken) tryUpgrade(i + 1);
                            }, 50);
                        } else {
                            setTimeout(() => {
                                if (token === bridge.state.renderToken) tryUpgrade(i);
                            }, Math.min(cooldown, 30000));
                        }
                        return;
                    }
                    bridge.loadImageFully(upgrades[i])
                        .then(() => {
                            item.src = upgrades[i];
                            item.upgradeSrcs = null;
                            setHd('max');
                            spinnerOff();
                            if (token !== bridge.state.renderToken || !img.parentNode) return;
                            img.addEventListener('load', () => {
                                if (token !== bridge.state.renderToken) return;

                                syncVerticalFitMediaBox(img);
                                if (!bridge.state.pan || bridge.state.pan.img !== img) return;

                                const zoomed = bridge.state.pan.zoomed;
                                const returnToFill = bridge.state.pan.returnToFill;
                                const v = bridge.state.pan.view ? bridge.state.pan.view() : null;
                                const wrapW = wrap.clientWidth;
                                const wrapH = wrap.clientHeight;
                                const cx = (v && v.dispW) ? (wrapW / 2 - v.x) / v.dispW : 0.5;
                                const cy = (v && v.dispH) ? (wrapH / 2 - v.y) / v.dispH : 0.5;

                                const newScale = (v && v.dispW && img.naturalWidth)
                                    ? v.dispW / img.naturalWidth
                                    : (zoomed ? 1 : Math.min(1, Math.max(wrapW / img.naturalWidth, wrapH / img.naturalHeight)));
                                const newDispW = img.naturalWidth * newScale;
                                const newDispH = img.naturalHeight * newScale;
                                enablePanForImage(wrap, img, {
                                    zoom: zoomed,
                                    scale: newScale,
                                    initialX: wrapW / 2 - cx * newDispW,
                                    initialY: wrapH / 2 - cy * newDispH,
                                    returnToFill: returnToFill
                                });
                            }, { once: true });
                            img.src = bridge.wrapMediaUrl(upgrades[i]);
                        })
                        .catch(() => tryUpgrade(i + 1));
                };
                tryUpgrade(0);
            };

            const showLoadedImage = (img, winnerSrc) => {
                if (token !== bridge.state.renderToken) return;
                if (winnerSrc && winnerSrc !== item.src && winnerSrc !== wrappedSrc) {
                    item.src = winnerSrc;
                }

                const box = ensureMediaBox(wrap);
                box.replaceChildren(img);
                Array.from(wrap.children).forEach((el) => {
                    if (el !== box && !el.classList.contains('ms-caption-overlay')) el.remove();
                });
                syncVerticalFitMediaBox(img);
                markItemMediaLoaded(item);
                if (item.error) {
                    appendErrorBanner(wrap, item.error);
                }
                if (bridge.autoPanEnabled && !item.msNoAutoPan && shouldAutoPan(wrap, img)) {
                    enablePanForImage(wrap, img);
                }
                if (!bridge.state.pan) {
                    const sliderWrap = bridge.state.overlay.querySelector('.ms-zoom-slider-wrap');
                    const slider = bridge.state.overlay.querySelector('.ms-zoom-slider');
                    if (sliderWrap && slider) {
                        sliderWrap.classList.remove('ms-zoom-idle');
                        const wrapW = wrap.clientWidth;
                        const wrapH = wrap.clientHeight;
                        const fitScale = Math.min(1, Math.min(wrapW / img.naturalWidth, wrapH / img.naturalHeight));
                        const minScale = Math.min(0.05, fitScale * 0.1);
                        const maxScale = Math.max(5.0, fitScale * 5.0);
                        slider.min = minScale;
                        slider.max = maxScale;
                        slider.step = (maxScale - minScale) / 200;
                        slider.value = fitScale;
                        const valueEl = bridge.state.overlay.querySelector('.ms-zoom-value');
                        if (valueEl) valueEl.textContent = Math.round(fitScale * 100) + '%';
                    }
                }

                if (item.xUnplayable && item.watchUrl) {
                    const watch = document.createElement('a');
                    watch.href = item.watchUrl;
                    watch.target = '_blank';
                    watch.rel = 'noopener noreferrer';
                    watch.innerHTML = '<svg style="width:14px;height:14px;vertical-align:middle;margin-right:6px;" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>Watch video on X';
                    watch.style.cssText = 'position:absolute; bottom:24px; left:50%; transform:translateX(-50%); z-index:12; background:#1d9bf0; color:#fff; text-decoration:none; font-size:14px; font-weight:700; padding:10px 22px; border-radius:22px; box-shadow:0 4px 16px rgba(0,0,0,0.4); font-family:system-ui,-apple-system,Segoe UI,sans-serif;';
                    watch.addEventListener('click', (e) => e.stopPropagation());
                    wrap.appendChild(watch);
                }
                img.addEventListener('click', (clickEvent) => {
                    clickEvent.stopPropagation();
                    handleImageZoomClick(wrap, img, item, clickEvent);
                });
                startUpgrade(img);
            };

            let lastFailure = '';
            const MAX_TRANSIENT_RETRIES = 2;
            const tryCandidate = (idx, attempt) => {
                if (token !== bridge.state.renderToken) return;
                const candidate = candidates[idx];
                const startLoad = () => {
                    if (token !== bridge.state.renderToken) return;
                    bridge.loadImageFully(candidate, 10000)
                        .then((img) => {
                            bridge.noteHostSuccess(candidate);
                            showLoadedImage(img, candidate);
                        })
                        .catch((err) => {
                            if (token !== bridge.state.renderToken) return;
                            const timedOut = !!(err && /^timeout:/.test(err.message || ''));
                            bridge.probeUrlStatus(candidate).then((probe) => {
                                if (token !== bridge.state.renderToken) return;
                                lastFailure = bridge.describeLoadFailure(probe.status, timedOut);
                                if (probe.status === 429 || probe.status === 503) {
                                    bridge.backoffHost(candidate, probe.retryAfterMs);
                                }
                                if (bridge.isTransientStatus(probe.status, timedOut) && attempt < MAX_TRANSIENT_RETRIES) {
                                    const delayMs = Math.max(bridge.hostCooldownRemaining(candidate), bridge.retryDelayMs(attempt));
                                    showStageNotice(wrap, lastFailure + ' - retrying in ' + Math.ceil(delayMs / 1000) + 's');
                                    setTimeout(() => tryCandidate(idx, attempt + 1), delayMs);
                                    return;
                                }
                                if (idx + 1 < candidates.length) {
                                    tryCandidate(idx + 1, 0);
                                } else {
                                    hideStageNotice(wrap);
                                    setTopbarLoading(false);
                                    renderErrorStage(wrap, (item.error || 'Failed to load media') + ' (' + lastFailure + ')', item.src, item);
                                }
                            });
                        });
                };
                const cooldown = bridge.hostCooldownRemaining(candidate);
                if (cooldown > 500 && attempt === 0) {
                    if (idx + 1 < candidates.length) {
                        tryCandidate(idx + 1, 0);
                    } else {

                        showStageNotice(wrap, 'Rate limited - waiting ' + Math.ceil(cooldown / 1000) + 's');
                        setTimeout(startLoad, Math.min(cooldown, 20000));
                    }
                } else {
                    startLoad();
                }
            };
            setTopbarLoading(true);
            tryCandidate(0, 0);
        } else if (item.type === 'video') {
            const predictedVideo = bridge.takePredictedVideo(item);
            let video = bridge.takeStageVideo(wrap, predictedVideo);
            const usedPredicted = video === predictedVideo;
            if (usedPredicted && video.error) {
                video.removeAttribute('src');
                try { video.load(); } catch (e) { }
            }
            const primaryVideoSrc = bridge.wrapMediaUrl(item.src);
            const bufferedVideo = bridge.requiresBufferedVideo(item);
            const videoPoster = bridge.reservedPostHeader && item.thumbSrc && item.thumbSrc !== item.src && !bridge.isPlaceholderUrl(item.thumbSrc)
                ? item.thumbSrc : '';
            video = globalThis.XGalleryCore.configureVideoElement({
                document: document,
                video: video,
                poster: videoPoster,
                volume: bridge.globalVolume,
                muted: bridge.globalMuted,
                loop: bridge.globalLoop,
                preload: usedPredicted ? '' : (bufferedVideo ? 'auto' : 'metadata')
            });

            let lastPlayTime = 0;
            let lastSeekAt = 0;
            let seekRecoveries = 0;
            const ownsVideoSession = () => token === bridge.state.renderToken && video.isConnected && wrap.contains(video);
            video.addEventListener('timeupdate', () => {
                if (video.currentTime > 0) lastPlayTime = video.currentTime;
            });
            video.addEventListener('seeking', () => { lastSeekAt = Date.now(); });
            video.addEventListener('seeked', () => { lastSeekAt = Date.now(); });

            if (bridge.state.lastPlayTime && bridge.state.lastPlayTime > 0) {
                const seekToTime = bridge.state.lastPlayTime;
                bridge.state.lastPlayTime = 0;
                const onCanPlay = () => {
                    if (!ownsVideoSession()) return;
                    video.currentTime = seekToTime;
                    video.removeEventListener('loadedmetadata', onCanPlay);
                    video.removeEventListener('canplay', onCanPlay);
                };
                video.addEventListener('loadedmetadata', onCanPlay);
                video.addEventListener('canplay', onCanPlay);
            }

            if (video.readyState >= 2) markItemMediaLoaded(item);
            else video.addEventListener('loadeddata', () => {
                if (!ownsVideoSession()) return;
                markItemMediaLoaded(item);
            }, { once: true });

            const retrySources = [];
            if (Array.isArray(item.altSrcs)) {
                item.altSrcs.forEach((s) => {
                    if (s && s !== item.src) retrySources.push(bridge.wrapMediaUrl(s));
                });
            }
            if (item.fallbackSrc && item.fallbackSrc !== item.src) retrySources.push(bridge.wrapMediaUrl(item.fallbackSrc));

            let retryIndex = 0;
            video.addEventListener('error', () => {
                if (!ownsVideoSession() || video._msRecovering) return;
                const errCode = video.error ? video.error.code : 0;
                const resumeAt = Math.max(video.currentTime || 0, lastPlayTime || 0);
                const seekGlitch = video.seeking || (Date.now() - lastSeekAt) < 1500 || errCode === 1;
                const duration = Number.isFinite(video.duration) ? video.duration : 0;
                const nearEndFailure = video.ended || (duration > 0 && resumeAt >= Math.max(0, duration - Math.max(0.75, duration * 0.01)));

                if (nearEndFailure && resumeAt > 0) {
                    video._msRecovering = true;
                    const src = video.currentSrc || video.src || primaryVideoSrc;
                    const resetForReplay = () => {
                        if (!ownsVideoSession()) return;
                        if (video._msEndRecoveryTimer) clearTimeout(video._msEndRecoveryTimer);
                        video._msRecovering = false;
                        try { video.currentTime = 0; } catch (e) { }
                        syncVerticalFitMediaBox(video);
                        if (bridge.globalLoop) {
                            const replay = video.play();
                            if (replay && typeof replay.catch === 'function') replay.catch(() => { });
                        } else {
                            try { video.pause(); } catch (e) { }
                        }
                    };
                    video.addEventListener('loadedmetadata', resetForReplay, { once: true });
                    video._msEndRecoveryTimer = setTimeout(() => { video._msRecovering = false; }, 4000);
                    try {
                        if (src && video.getAttribute('src') !== src) video.src = src;
                        else video.load();
                    } catch (e) { video._msRecovering = false; }
                    return;
                }

                if (seekGlitch && resumeAt > 0 && seekRecoveries < 2) {
                    seekRecoveries++;
                    video._msRecovering = true;
                    const src = video.currentSrc || video.src || primaryVideoSrc;
                    const resume = () => {
                        if (!ownsVideoSession()) return;
                        video._msRecovering = false;
                        try { video.currentTime = resumeAt; } catch (e) { }
                        const p = video.play();
                        if (p && typeof p.catch === 'function') p.catch(() => { });
                    };
                    try {
                        if (src && video.getAttribute('src') !== src) video.src = src;
                        else video.load();
                        video.addEventListener('loadedmetadata', resume, { once: true });
                    } catch (e) { video._msRecovering = false; }
                    return;
                }
                const failedSrc = video.currentSrc || video.src || item.src;
                const signedHost = presentation.signedVideo;
                const neverPlayed = resumeAt < 0.25 && video.readyState < 2;
                if (signedHost && neverPlayed && item.resolveUrl && !item._signedRefreshTried) {
                    item._signedRefreshTried = true;
                    bridge.resolvedFileUrlCache.delete(item.resolveUrl);
                    bridge.resolvingFileUrlCache.delete(item.resolveUrl);
                    bridge.state.lastPlayTime = resumeAt;
                    item.needsResolve = true;
                    delete item.error;
                    renderCurrent();
                    return;
                }
                if (retryIndex >= retrySources.length) {
                    if (item.embedSrc) {
                        item.src = item.embedSrc;
                        item.type = 'iframe';
                        item.needsResolve = false;
                        renderCurrent();
                        return;
                    }
                    renderErrorStage(wrap, item.error || 'Failed to load video resource.', item.src, item);
                    return;
                }
                const nextSrc = retrySources[retryIndex++];
                video.src = nextSrc;
                if (resumeAt > 0) {
                    const seekToTime = resumeAt;
                    const onCanPlay = () => {
                        if (!ownsVideoSession()) return;
                        video.currentTime = seekToTime;
                        video.removeEventListener('loadedmetadata', onCanPlay);
                        video.removeEventListener('canplay', onCanPlay);
                    };
                    video.addEventListener('loadedmetadata', onCanPlay);
                    video.addEventListener('canplay', onCanPlay);
                }
                const retry = video.play();
                if (retry && typeof retry.catch === 'function') retry.catch(() => { });
            });

            video.addEventListener('volumechange', () => {
                if (!ownsVideoSession()) return;
                bridge.globalVolume = video.volume;
                bridge.globalMuted = video.muted;
                bridge.savePreference('MS_BETTER_VIDEO_VOLUME', bridge.globalVolume);
                bridge.savePreference('MS_BETTER_VIDEO_MUTED', bridge.globalMuted);
            });
            video.addEventListener('loadedmetadata', () => {
                if (ownsVideoSession()) syncVerticalFitMediaBox(video);
            });
            if (!video.isConnected || !video.closest('.ms-media-box')) ensureMediaBox(wrap).appendChild(video);
            const revealVideo = () => {
                if (!ownsVideoSession()) return;
                wrap.querySelectorAll('img.ms-media, img.ms-loading-thumb').forEach((el) => el.remove());
                video.classList.add('ms-ready');
                video.style.opacity = '1';
                syncVerticalFitMediaBox(video);
            };
            if (video.readyState >= 1) revealVideo();
            else video.addEventListener('loadedmetadata', revealVideo, { once: true });
            if (!bridge.reservedPostHeader && !wrap.querySelector('img') && item.thumbSrc && !bridge.isPlaceholderUrl(item.thumbSrc)) {
                const standIn = globalThis.XGalleryCore.createLoadingPreview({
                    document: document,
                    src: item.thumbSrc,
                    onLoad: (image) => {
                        if (image.isConnected) syncVerticalFitMediaBox(image);
                    }
                });
                ensureMediaBox(wrap).insertBefore(standIn, video);
                if (standIn.complete) syncVerticalFitMediaBox(standIn);
            }
            let videoActivated = false;
            const activateVideo = () => {
                if (videoActivated || token !== bridge.state.renderToken || !video.isConnected) return;
                videoActivated = true;
                video.preload = bufferedVideo ? 'auto' : 'metadata';
                if (!video.getAttribute('src')) video.src = primaryVideoSrc;
                const promise = video.play();
                if (promise && typeof promise.catch === 'function') promise.catch(() => { });
            };
            video.addEventListener('pointerdown', activateVideo, { once: true });
            if ((usedPredicted || bufferedVideo) && !video.getAttribute('src')) video.src = primaryVideoSrc;
            setTimeout(activateVideo, usedPredicted || bufferedVideo ? 0 : presentation.videoDelay);
        } else {
            if (presentation.coverAlbum) {
                const coverImg = globalThis.XGalleryCore.createImageMedia({
                    document: document,
                    src: bridge.wrapMediaUrl(item.thumbSrc || item.src),
                    onLoad: image => { syncVerticalFitMediaBox(image); markItemMediaLoaded(item); }
                });
                coverImg.style.cssText = 'max-height: 100%; max-width: 100%; object-fit: contain;';
                ensureMediaBox(wrap).appendChild(coverImg);
            } else {
                const iframe = globalThis.XGalleryCore.createIframeMedia({
                    document: document,
                    src: item.src,
                    onLoad: () => markItemMediaLoaded(item)
                });
                wrap.appendChild(iframe);

                const shield = globalThis.XGalleryCore.createIframeShield({
                    document: document,
                    onRelease: () => window.focus()
                });
                wrap.appendChild(shield);
            }

            if (presentation.expandable && item.type !== 'img' && item.type !== 'video') {
                const btn = globalThis.XGalleryCore.createExpandButton({
                    document: document,
                    label: presentation.coverAlbum ? 'Expand gallery' : 'Expand album',
                    onExpand: () => {
                    if (bridge.folderFavorites) bridge.expandPhotoAlbum(item.src, bridge.state.currentIndex);
                    else bridge.expandSingleRemoteAlbum(item.src, bridge.state.currentIndex);
                    }
                });
                wrap.appendChild(btn);
            }
        }

        let domain = '';
        try {
            if (item.resolveUrl) {
                const parsedUrl = new URL(item.resolveUrl);
                domain = parsedUrl.hostname.replace('www.', '');
            } else if (item.src) {
                const parsedUrl = new URL(item.src);
                domain = parsedUrl.hostname.replace('www.', '');
            }
        } catch (e) {
            domain = 'unknown';
        }

        info.innerHTML = buildInfoHtml();
        const position = bridge.galleryPositionSnapshot();
        globalThis.XGalleryCore.renderPosition({
            counter: counter,
            previous: prevBtn,
            next: nextBtn,
            currentIndex: position.currentIndex,
            length: position.length
        });
        updatePositionControl();

        setActiveThumb(thumbs, true);

        bridge.updateTopbarStates();
        bridge.refreshTitleRow();
        updateMediaCaptionOverlay(item);
        if (bridge.needsPostDetails(item) && typeof bridge.ensurePostDetails === 'function') {
            bridge.ensurePostDetails(item, () => {
                const current = bridge.state.items[bridge.state.currentIndex];
                const currentItem = current ? (current.item || current) : null;
                if (currentItem !== item) return;
                updateMediaCaptionOverlay(item);
                const tagsOverlay = bridge.state.overlay && bridge.state.overlay.querySelector('.ms-tags-overlay');
                if (tagsOverlay && tagsOverlay.classList.contains('active')) bridge.applyTagsPanel(true);
            });
        }

        bridge.schedulePreloadAroundCurrent(bridge.state.navigationDirection ? 100 : 250);
    }

function paintCurrentLikeButton(liked, count) {
        if (!bridge.state.overlay) return;
        const likeEl = bridge.state.overlay.querySelector('.ms-tags-like-btn');
        if (!likeEl) return;
        likeEl.classList.toggle('active', !!liked);
        let countEl = likeEl.querySelector('.ms-tags-like-count');
        if (count !== '' && count != null) {
            if (!countEl) {
                countEl = document.createElement('span');
                countEl.className = 'ms-tags-like-count';
                likeEl.appendChild(countEl);
            }
            countEl.textContent = String(count);
        }
    }

function paintPostActions(data) {
        if (!bridge.state.overlay) return;
        const entry = bridge.state.items[bridge.state.currentIndex];
        const item = entry ? (entry.item || entry) : null;
        const currentId = bridge.actionPostId(item);
        const likeBtn = bridge.state.overlay.querySelector('[data-act="x-like"]');
        const bookmarkBtn = bridge.state.overlay.querySelector('[data-act="x-bookmark"]');
        const visible = !!currentId;
        if (likeBtn) {
            likeBtn.style.display = visible ? '' : 'none';
            likeBtn.disabled = !visible || !data || data.tweetId !== currentId || !data.likeAvailable;
            likeBtn.classList.toggle('active', !!(data && data.tweetId === currentId && data.liked));
            likeBtn.title = likeBtn.disabled ? 'Like unavailable for this post' : (data.liked ? 'Unlike post' : 'Like post');
        }
        if (bookmarkBtn) {
            bookmarkBtn.style.display = visible ? '' : 'none';
            bookmarkBtn.disabled = !visible || !data || data.tweetId !== currentId || !data.bookmarkAvailable;
            bookmarkBtn.classList.toggle('active', !!(data && data.tweetId === currentId && data.bookmarked));
            bookmarkBtn.title = bookmarkBtn.disabled ? 'Bookmark unavailable for this post' : (data.bookmarked ? 'Remove bookmark' : 'Bookmark post');
        }
    }
function addSettingsGearButton() {
        if (document.getElementById('ms-site-settings-btn')) return;
        const gear = document.createElement('button');
        gear.id = 'ms-site-settings-btn';
        gear.className = 'ms-site-settings-btn';
        gear.innerHTML = '<svg style="width:18px;height:18px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" fill="none"/><path fill="none" d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
        gear.title = 'Gallery Settings';
        gear.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            bridge.showGallerySettings();
        });
        gear.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });
        document.body.appendChild(gear);
    }

function closeFavoriteMenu() {
        if (!bridge.state.overlay) return;
        const menu = bridge.state.overlay.querySelector('.ms-imgfap-fav-menu');
        if (menu) menu.remove();
    }

function positionFavoriteMenu(menu, anchor) {
        if (!menu || !anchor) return;
        const rect = anchor.getBoundingClientRect();
        const top = Math.max(12, Math.min(window.innerHeight - menu.offsetHeight - 12, rect.bottom + 8));
        menu.style.top = top + 'px';
        menu.style.right = Math.max(12, window.innerWidth - rect.right) + 'px';
    }

function setFavoriteMenuStatus(menu, text, kind) {
        const status = menu && menu.querySelector('.ms-imgfap-fav-status');
        if (!status) return;
        status.textContent = text || '';
        status.className = 'ms-imgfap-fav-status' + (kind ? ' ' + kind : '');
    }

function addFavoriteMenuSection(menu, item, kind, options) {
        if (!menu || !options || !options.length) return;
        const section = document.createElement('div');
        section.className = 'ms-imgfap-fav-section';
        const label = document.createElement('label');
        label.className = 'ms-imgfap-fav-label';
        label.textContent = kind === 'gallery' ? 'Gallery folder' : 'Image folder';
        section.appendChild(label);

        const controls = document.createElement('div');
        controls.className = 'ms-imgfap-fav-controls';
        const select = document.createElement('select');
        options.forEach((option) => {
            const node = document.createElement('option');
            node.value = option.value;
            node.textContent = option.label;
            select.appendChild(node);
        });
        controls.appendChild(select);

        const add = document.createElement('button');
        add.type = 'button';
        add.textContent = 'Add';
        add.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const value = select.value;
            const needsName = value === '0' || value === '__NEW_PICTURE__';
            let newName = '';
            if (needsName) {
                newName = window.prompt(kind === 'gallery' ? 'New gallery folder name' : 'New image folder name', '') || '';
                if (!newName.trim()) return;
            }
            add.disabled = true;
            select.disabled = true;
            setFavoriteMenuStatus(menu, 'Saving...', '');
            try {
                const result = await bridge.saveFavorite(item, kind, value, newName);
                bridge.recordFolderFavorite(item, kind);
                const favBtn = bridge.state.overlay && bridge.state.overlay.querySelector('[data-act="fav-toggle"]');
                if (favBtn) favBtn.classList.add('active');
                setFavoriteMenuStatus(menu, result.message || 'Added to favorites.', 'success');
            } catch (error) {
                setFavoriteMenuStatus(menu, error && error.message ? error.message : 'Could not add this favorite.', 'error');
            } finally {
                add.disabled = false;
                select.disabled = false;
            }
        });
        controls.appendChild(add);
        section.appendChild(controls);
        menu.insertBefore(section, menu.querySelector('.ms-imgfap-fav-status'));
    }

async function openFavoriteFolders(item, anchor) {
        if (!bridge.state.overlay || !item || !anchor) return;
        const ids = bridge.favoriteIdentifiers(item);
        const key = ids.gid + '|' + ids.photoId;
        const existing = bridge.state.overlay.querySelector('.ms-imgfap-fav-menu');
        if (existing && existing.dataset.key === key) {
            existing.remove();
            return;
        }
        closeFavoriteMenu();

        const menu = document.createElement('div');
        menu.className = 'ms-imgfap-fav-menu';
        menu.dataset.key = key;
        menu.innerHTML = '<div class="ms-imgfap-fav-title">Add to favorites</div><div class="ms-imgfap-fav-status">Loading folders...</div>';
        menu.addEventListener('click', (event) => event.stopPropagation());
        bridge.state.overlay.appendChild(menu);
        positionFavoriteMenu(menu, anchor);

        try {
            const data = await bridge.loadFavoriteFolders(item);
            if (!menu.isConnected || menu.dataset.key !== key) return;
            addFavoriteMenuSection(menu, item, 'gallery', data.galleryFolders || []);
            addFavoriteMenuSection(menu, item, 'image', data.imageFolders || []);
            setFavoriteMenuStatus(menu, data.error || '', data.error ? 'error' : '');
            requestAnimationFrame(() => positionFavoriteMenu(menu, anchor));
        } catch (error) {
            setFavoriteMenuStatus(menu, error && error.message ? error.message : 'Could not load favorite folders.', 'error');
        }
    }
return { createLauncher, beginOpen, resetLayout, finishOpen, clearViewerMedia, revealHost, addSettingsGearButton, closeFavoriteMenu, positionFavoriteMenu, setFavoriteMenuStatus, addFavoriteMenuSection, openFavoriteFolders, showPostPanel, setInfoPanelVisible, isInfoPanelVisible, setTitlePanelVisible, refreshGridSize, renderTitleRow, paintTopbar, renderCurrent, paintCurrentLikeButton, paintPostActions, showStageNotice, hideStageNotice, showGalleryEndNotice, getLoadingOverlay, showLoadingOverlay, updateLoadingOverlay, hideLoadingOverlay, ensureOverlay, onOverlayClick, tagsPanelIsScrollable, onOverlayWheel, navigateFromWheel, getWheelNavigationDirection, updateDropdownActiveStates, setBtnLabel, measureRowContentWidth, topbarLayoutSignature, updateTopbarCompact, bindTopbarCompactObserver, updateButtons, updatePositionControl, commitPositionInput, bindPositionControl, ensureMediaBox, syncVerticalFitMediaBox, applyFitClass, toggleThumbs, animateFlyToGrid, setGridMode, buildGridCell, renderGrid, disablePan, applyTitleRowHeight, applyTagsFontSize, bindTitleRowResizer, bindTagsPanelResizer, toggleTagsPanel, captionHtmlFromItem, captionFitsSnapchat, setCaptionMode, clickCaptionModeButton, handleCaptionModeMessage, applyCaptionSnapInset, bindCaptionSnapDrag, updateMediaCaptionOverlay, appendCaptionModeControls, setTopbarLoading, updateHdButton, enablePanForImage, shouldAutoPan, togglePanMode, clearFullscreenIdleTimer, scheduleFullscreenIdleHide, wakeFullscreenTopbar, toggleStageFullscreen, handleImageZoomClick, createPlaceholderIcon, getPastelColorForGroupId, getSourceClass, promoteLazyThumbVideo, promoteLazyMp4Poster, observeLazyThumb, createLazyThumbVideo, createLazyMp4PosterImg, appendVideoThumbMedia, stopThumbTrackAnimation, animateThumbTrackTo, setActiveThumb, thumbStripCenterTarget, applyThumbStripCenter, thumbSourceClass, thumbItemKey, resetMediaThumbEl, onWindowedThumbClick, onWindowedGridClick, fillThumbButton, invalidateThumbGroupData, thumbGroupData, thumbsGroupCounts, ensureThumbsWindow, onThumbsWindowScroll, takePoolCell, paintThumbsWindow, paintLoadMarks, paintThumbGroupOutlines, syncThumbsWindow, gridMetrics, ensureGridWindow, onGridWindowScroll, paintGridWindow, fillGridCell, syncGridWindow, renderThumbs, updateSingleThumb, markItemMediaLoaded, enableThumbDragScroll, appendErrorBanner, renderErrorStage, prepareMediaWrap, bindGlobalGalleryHandlers, unbindGlobalGalleryHandlers, closeGallerySettings, openInGalleryButtonHtml, createOpenInGalleryButton };
}
