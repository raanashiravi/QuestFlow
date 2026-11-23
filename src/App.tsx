import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  CampusMeeting,
  CampusSettings,
  DEFAULT_CAMPUS_SETTINGS,
  SAMPLE_DEFAULT_OFFICE,
  UserOffice,
} from './types';
import { PageStepper, AppPage } from './components/PageStepper';
import { WelcomeHeroPage } from './components/pages/WelcomeHeroPage';
import { NextMeetingPage } from './components/pages/NextMeetingPage';
import { ConnectCalendarPage } from './components/pages/ConnectCalendarPage';
import { CalendarReviewPage } from './components/pages/CalendarReviewPage';
import { MeetingModal } from './components/MeetingModal';
import { getSampleDayMeetings } from './data/sampleDay';
import { getTodayLocalDateString } from './utils/icsParser';
import { playDepartureChime } from './utils/audioChime';
import {
  formatTime12h,
  getDepartureForMeeting,
} from './utils/travelCalculator';
import { getGoogleMapsDirectionsUrl } from './utils/googleMapsLinks';
import {
  connectGoogleCalendar,
  createGoogleEvent,
  deleteGoogleEvent,
  disconnectGoogleCalendar,
  fetchGoogleEventsForDate,
  getGoogleAuthState,
  isGoogleCalendarConfigured,
  subscribeGoogleAuthState,
  updateGoogleEvent,
} from './utils/googleCalendar';
import { AlertCircle, Bell, Navigation, X, ExternalLink } from 'lucide-react';

export type CalendarSourceMode = 'tutorial' | 'google' | 'file' | null;

function readInitialSourceBuckets(): {
  googleMeetings: CampusMeeting[];
  fileMeetings: CampusMeeting[];
  activeSource: CalendarSourceMode;
} {
  let googleMeetings: CampusMeeting[] = [];
  let fileMeetings: CampusMeeting[] = [];
  let activeSource: CalendarSourceMode = null;

  try {
    const savedGoogle = localStorage.getItem('questflow_google_meetings_v6');
    const savedFile = localStorage.getItem('questflow_file_meetings_v6');
    const savedSource = localStorage.getItem('questflow_active_source_v6');

    if (savedGoogle) {
      const parsed = JSON.parse(savedGoogle);
      if (Array.isArray(parsed)) googleMeetings = parsed;
    }
    if (savedFile) {
      const parsed = JSON.parse(savedFile);
      if (Array.isArray(parsed)) fileMeetings = parsed;
    }

    // Legacy migration if separate buckets haven't been initialized yet
    if (!savedGoogle && !savedFile) {
      const legacy = localStorage.getItem('questflow_meetings_v6');
      if (legacy) {
        const parsed = JSON.parse(legacy);
        if (Array.isArray(parsed)) {
          googleMeetings = parsed.filter((m: CampusMeeting) => Boolean(m.googleEventId));
          fileMeetings = parsed.filter(
            (m: CampusMeeting) => !m.googleEventId && m.source !== 'sample'
          );
        }
      }
    }

    if (getGoogleAuthState().isConnected) {
      activeSource = 'google';
    } else if (savedSource === 'file' && fileMeetings.length > 0) {
      activeSource = 'file';
    } else if (savedSource === 'google' && googleMeetings.length > 0) {
      activeSource = 'google';
    } else if (fileMeetings.length > 0) {
      activeSource = 'file';
    } else if (googleMeetings.length > 0) {
      activeSource = 'google';
    }
  } catch {}

  return { googleMeetings, fileMeetings, activeSource };
}

export default function App() {
  const initialBucketsRef = useRef(readInitialSourceBuckets());

  // Separate meeting stores per source:
  // - tutorialMeetings: in-memory only, discarded when leaving tutorial
  // - googleMeetings: stored separately in localStorage
  // - fileMeetings: stored separately in localStorage (.ics, link, pasted text)
  const [tutorialMeetings, setTutorialMeetings] = useState<CampusMeeting[]>([]);
  const [googleMeetings, setGoogleMeetings] = useState<CampusMeeting[]>(
    () => initialBucketsRef.current.googleMeetings
  );
  const [fileMeetings, setFileMeetings] = useState<CampusMeeting[]>(
    () => initialBucketsRef.current.fileMeetings
  );
  const [activeSource, setActiveSource] = useState<CalendarSourceMode>(
    () => initialBucketsRef.current.activeSource
  );

  const meetings =
    activeSource === 'tutorial'
      ? tutorialMeetings
      : activeSource === 'google'
      ? googleMeetings
      : activeSource === 'file'
      ? fileMeetings
      : [];

  const updateActiveMeetings = useCallback(
    (updater: (prev: CampusMeeting[]) => CampusMeeting[]) => {
      if (activeSource === 'tutorial') {
        setTutorialMeetings(updater);
      } else if (activeSource === 'google') {
        setGoogleMeetings(updater);
      } else if (activeSource === 'file') {
        setFileMeetings(updater);
      }
    },
    [activeSource]
  );

  // Page Stepper navigation state:
  // - In public demo mode, always open straight on 'welcome' (Home)
  // - First-run visitors land on 'welcome'
  // - Returning users with meetings loaded open directly on 'review' (Calendar)
  const [currentPage, setCurrentPage] = useState<AppPage>(() => {
    if (import.meta.env.VITE_PUBLIC_DEMO === 'true') {
      return 'welcome';
    }
    try {
      const hasVisited = localStorage.getItem('questflow_visited_v6') === 'true';
      localStorage.setItem('questflow_visited_v6', 'true');
      if (!hasVisited) {
        return 'welcome';
      }
      const init = initialBucketsRef.current;
      if (
        (init.activeSource === 'google' && init.googleMeetings.length > 0) ||
        (init.activeSource === 'file' && init.fileMeetings.length > 0)
      ) {
        return 'review';
      }
      const savedPage = localStorage.getItem('questflow_page_v6');
      if (savedPage && ['welcome', 'connect', 'review'].includes(savedPage)) {
        return savedPage as AppPage;
      }
      if (savedPage === 'next') {
        return 'review';
      }
    } catch {}
    return 'welcome';
  });

  // Track previous page so "Back" on ConnectCalendarPage returns to the page actually visited
  const [previousPage, setPreviousPage] = useState<AppPage>(() =>
    currentPage === 'review' ? 'review' : 'welcome'
  );

  // Next Up modal box visibility (opened from Calendar blue time strip or Welcome shortcut)
  const [isNextUpOpen, setIsNextUpOpen] = useState(false);
  const nextUpDialogRef = useRef<HTMLDivElement>(null);

  // Selected date
  const [selectedDate, setSelectedDate] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('questflow_date_v6');
      if (saved) return saved;
    } catch {}
    return getTodayLocalDateString();
  });

  // Settings
  const [settings, setSettings] = useState<CampusSettings>(() => {
    try {
      const saved = localStorage.getItem('questflow_settings_v6');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed?.office && Number(parsed.office.returnMinGapMinutes) === 30) {
          parsed.office.returnMinGapMinutes = 45;
        }
        if (parsed?.notifications) {
          parsed.notifications.soundAlert = false;
        }
        return parsed;
      }
    } catch {}
    return DEFAULT_CAMPUS_SETTINGS;
  });

  // Modal state for Adding/Editing Meetings
  const [isMeetingModalOpen, setIsMeetingModalOpen] = useState(false);
  const [meetingToEdit, setMeetingToEdit] = useState<CampusMeeting | null>(null);

  // Google Calendar in-memory auth state
  const [googleAuthState, setGoogleAuthState] = useState(() => getGoogleAuthState());
  const [isGoogleBusy, setIsGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const pendingGoogleWritesRef = useRef(0);

  useEffect(() => {
    return subscribeGoogleAuthState(() => {
      setGoogleAuthState(getGoogleAuthState());
    });
  }, []);

  // Merge Google events into googleMeetings for a target date:
  // Replace only Google events for that date (matched by googleEventId / questflow id).
  const mergeGoogleEventsForDate = useCallback(
    (dateStr: string, loadedGoogleMeetings: CampusMeeting[]) => {
      setGoogleMeetings((prev) => {
        const existingByGoogleId = new Map<string, CampusMeeting>();
        const existingById = new Map<string, CampusMeeting>();
        for (const m of prev) {
          existingById.set(m.id, m);
          if (m.googleEventId) {
            existingByGoogleId.set(m.googleEventId, m);
          }
        }

        const loadedGoogleIds = new Set<string>();
        const loadedQuestFlowIds = new Set<string>();
        for (const gm of loadedGoogleMeetings) {
          if (gm.googleEventId) loadedGoogleIds.add(gm.googleEventId);
          loadedQuestFlowIds.add(gm.id);
        }

        const kept = prev.filter((m) => {
          if (m.googleEventId && loadedGoogleIds.has(m.googleEventId)) {
            return false;
          }
          if (loadedQuestFlowIds.has(m.id)) {
            return false;
          }
          if (m.date === dateStr) {
            return false;
          }
          return true;
        });

        const normalizedGoogle = loadedGoogleMeetings.map((gm) => {
          const existing =
            (gm.googleEventId ? existingByGoogleId.get(gm.googleEventId) : undefined) ||
            existingById.get(gm.id);
          if (!existing) return gm;
          return {
            ...gm,
            id: existing.id,
            format:
              existing.questflowCreated &&
              existing.format === 'hybrid' &&
              !gm.isOnline
                ? 'hybrid'
                : gm.format,
            onlineLink: existing.onlineLink || gm.onlineLink,
          };
        });

        const combined = [...kept, ...normalizedGoogle];
        combined.sort((a, b) => a.startTime.localeCompare(b.startTime));
        return combined;
      });
    },
    []
  );

  const loadGoogleEventsForDate = useCallback(
    async (dateStr: string): Promise<number> => {
      if (!getGoogleAuthState().isConnected) return 0;
      const loaded = await fetchGoogleEventsForDate(dateStr);
      mergeGoogleEventsForDate(dateStr, loaded);
      return loaded.length;
    },
    [mergeGoogleEventsForDate]
  );

  // Reload Google Calendar events when selectedDate changes, when tab regains focus, and every 60s while visible
  // Paused in Tutorial mode or File mode (only active when activeSource === 'google')
  useEffect(() => {
    if (!googleAuthState.isConnected || activeSource !== 'google') return;

    const triggerReload = () => {
      if (pendingGoogleWritesRef.current > 0) return;
      if (!getGoogleAuthState().isConnected) return;
      loadGoogleEventsForDate(selectedDate).catch((err: any) => {
        setGoogleError(err?.message || 'Could not load Google Calendar events.');
      });
    };

    triggerReload();

    const handleFocus = () => {
      triggerReload();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        triggerReload();
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        triggerReload();
      }
    }, 60000);

    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearInterval(interval);
    };
  }, [googleAuthState.isConnected, activeSource, selectedDate, loadGoogleEventsForDate]);

  const handleConnectGoogle = async (): Promise<number> => {
    setIsGoogleBusy(true);
    setGoogleError(null);
    try {
      await connectGoogleCalendar();
      setGoogleAuthState(getGoogleAuthState());
      setTutorialMeetings([]);
      setActiveSource('google');
      const count = await loadGoogleEventsForDate(selectedDate);
      return count;
    } catch (err: any) {
      setGoogleError(err?.message || 'Could not connect Google Calendar.');
      throw err;
    } finally {
      setIsGoogleBusy(false);
    }
  };

  const handleDisconnectGoogle = () => {
    disconnectGoogleCalendar();
    setGoogleAuthState(getGoogleAuthState());
    setGoogleError(null);
    if (activeSource === 'google') {
      setActiveSource(fileMeetings.length > 0 ? 'file' : null);
    }
  };

  // Active departure toast banner
  const [activeDepartureAlert, setActiveDepartureAlert] = useState<{
    meetingTitle: string;
    originBuildingCode?: string;
    buildingCode: string;
    roomNumber: string;
    departureTime: string;
    travelMinutes: number;
  } | null>(null);

  // Persist separate source buckets to localStorage (tutorial meetings are never persisted)
  useEffect(() => {
    try {
      localStorage.setItem('questflow_google_meetings_v6', JSON.stringify(googleMeetings));
      localStorage.setItem('questflow_file_meetings_v6', JSON.stringify(fileMeetings));
      if (activeSource === 'google' || activeSource === 'file') {
        localStorage.setItem('questflow_active_source_v6', activeSource);
      } else if (activeSource === null) {
        localStorage.removeItem('questflow_active_source_v6');
      }
      localStorage.setItem('questflow_date_v6', selectedDate);
      localStorage.setItem('questflow_settings_v6', JSON.stringify(settings));
      localStorage.setItem('questflow_page_v6', currentPage);
    } catch {}
  }, [googleMeetings, fileMeetings, activeSource, selectedDate, settings, currentPage]);

  // Close Next Up modal on Escape & trap focus inside dialog
  useEffect(() => {
    if (!isNextUpOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsNextUpOpen(false);
        return;
      }
      if (e.key === 'Tab' && nextUpDialogRef.current) {
        const focusable = nextUpDialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first || !nextUpDialogRef.current.contains(document.activeElement)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last || !nextUpDialogRef.current.contains(document.activeElement)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isNextUpOpen]);

  // Departure check background interval
  useEffect(() => {
    if (!settings.notifications?.enabled) return;
    if (meetings.length === 0) return;

    const checkDepartures = () => {
      const now = new Date();
      const currentMin = now.getHours() * 60 + now.getMinutes();
      const todayStr = getTodayLocalDateString(now);

      const todayList = meetings
        .filter((m) => m.date === todayStr && m.format !== 'online')
        .sort((a, b) => a.startTime.localeCompare(b.startTime));

      for (let i = 0; i < todayList.length; i++) {
        const m = todayList[i];
        const prev = i > 0 ? todayList[i - 1] : null;
        const dep = getDepartureForMeeting(m, prev, settings);
        if (!dep.hasOrigin) continue;

        const departMin = dep.leaveByMinutes;
        const travelMin = dep.walkMinutes;
        const originBuildingCode = dep.originBuildingCode;

        // Trigger alert within 2-minute window
        if (Math.abs(currentMin - departMin) <= 1) {
          const alertKey = `alerted_${m.id}_${todayStr}`;
          if (!sessionStorage.getItem(alertKey)) {
            sessionStorage.setItem(alertKey, 'true');
            if (settings.notifications?.soundAlert) {
              playDepartureChime();
            }
            setActiveDepartureAlert({
              meetingTitle: m.title,
              originBuildingCode,
              buildingCode: m.buildingCode || 'Campus',
              roomNumber: m.roomNumber || '',
              departureTime: formatTime12h(m.startTime),
              travelMinutes: travelMin,
            });
          }
        }
      }
    };

    const interval = setInterval(checkDepartures, 30000);
    return () => clearInterval(interval);
  }, [meetings, settings]);

  // Load UW Sample walkthrough and open Calendar (Tutorial mode)
  const handleStartSampleWalkthrough = () => {
    const todayStr = getTodayLocalDateString();
    const sample = getSampleDayMeetings(todayStr);
    const sampleDate = sample[0]?.date || todayStr;
    setSelectedDate(sampleDate);
    setTutorialMeetings(sample);
    setActiveSource('tutorial');
    setSettings((prev) => ({
      ...prev,
      office: prev.office ?? SAMPLE_DEFAULT_OFFICE,
    }));
    setCurrentPage('review');
  };

  // Exit tutorial mode: discard tutorial meetings, return to Google mode if connected, else Sync Calendar page
  const handleExitTutorial = () => {
    setTutorialMeetings([]);
    if (getGoogleAuthState().isConnected) {
      setActiveSource('google');
      setCurrentPage('review');
    } else {
      setActiveSource(fileMeetings.length > 0 ? 'file' : null);
      setCurrentPage('connect');
    }
  };

  // Open Edit Meeting Modal
  const handleOpenEditMeeting = (meeting: CampusMeeting) => {
    setMeetingToEdit(meeting);
    setIsMeetingModalOpen(true);
  };

  // Open New Meeting Modal
  const handleOpenNewMeeting = () => {
    setMeetingToEdit(null);
    setIsMeetingModalOpen(true);
  };

  // Save Meeting (Add or Update) in the currently active source
  const handleSaveMeeting = (meeting: CampusMeeting) => {
    const targetSource: 'tutorial' | 'google' | 'file' =
      activeSource || (getGoogleAuthState().isConnected ? 'google' : 'file');

    if (!activeSource) {
      setActiveSource(targetSource);
    }

    const isGoogleModeConnected =
      targetSource === 'google' && getGoogleAuthState().isConnected;

    const existing = meetings.find((m) => m.id === meeting.id);

    if (existing) {
      const merged: CampusMeeting = {
        ...meeting,
        googleEventId: existing.googleEventId,
        questflowCreated: existing.questflowCreated,
        source: existing.questflowCreated ? 'created' : meeting.source,
      };
      const applyUpdate = (prev: CampusMeeting[]) =>
        prev
          .map((m) => (m.id === meeting.id ? merged : m))
          .sort((a, b) => a.startTime.localeCompare(b.startTime));

      if (targetSource === 'tutorial') setTutorialMeetings(applyUpdate);
      else if (targetSource === 'google') setGoogleMeetings(applyUpdate);
      else setFileMeetings(applyUpdate);

      if (isGoogleModeConnected && merged.googleEventId && merged.questflowCreated) {
        pendingGoogleWritesRef.current += 1;
        setGoogleError(null);
        updateGoogleEvent(merged)
          .catch((err: any) => {
            setGoogleError(err?.message || 'Could not update meeting in Google Calendar.');
          })
          .finally(() => {
            pendingGoogleWritesRef.current = Math.max(0, pendingGoogleWritesRef.current - 1);
          });
      }
    } else {
      const createdMeeting: CampusMeeting = {
        ...meeting,
        source: 'created',
        questflowCreated: isGoogleModeConnected ? true : undefined,
      };
      const applyAdd = (prev: CampusMeeting[]) =>
        [...prev, createdMeeting].sort((a, b) => a.startTime.localeCompare(b.startTime));

      if (targetSource === 'tutorial') setTutorialMeetings(applyAdd);
      else if (targetSource === 'google') setGoogleMeetings(applyAdd);
      else setFileMeetings(applyAdd);

      if (isGoogleModeConnected) {
        pendingGoogleWritesRef.current += 1;
        setGoogleError(null);
        createGoogleEvent(createdMeeting)
          .then((googleEventId) => {
            setGoogleMeetings((prev) =>
              prev.map((m) =>
                m.id === createdMeeting.id
                  ? { ...m, googleEventId, questflowCreated: true, source: 'created' }
                  : m
              )
            );
          })
          .catch((err: any) => {
            setGoogleError(err?.message || 'Could not save meeting to Google Calendar.');
          })
          .finally(() => {
            pendingGoogleWritesRef.current = Math.max(0, pendingGoogleWritesRef.current - 1);
          });
      }
    }
  };

  // Delete Meeting in the currently active source
  const handleDeleteMeeting = (id: string) => {
    const existing = meetings.find((m) => m.id === id);
    updateActiveMeetings((prev) => prev.filter((m) => m.id !== id));

    if (
      activeSource === 'google' &&
      existing &&
      getGoogleAuthState().isConnected &&
      existing.googleEventId &&
      existing.questflowCreated
    ) {
      pendingGoogleWritesRef.current += 1;
      setGoogleError(null);
      deleteGoogleEvent(existing)
        .catch((err: any) => {
          setGoogleError(err?.message || 'Could not delete meeting from Google Calendar.');
        })
        .finally(() => {
          pendingGoogleWritesRef.current = Math.max(0, pendingGoogleWritesRef.current - 1);
        });
    }
  };

  // 1-Click format toggle (in_person, online, hybrid) in the currently active source
  const handleQuickToggleFormat = (id: string, format: 'in_person' | 'online' | 'hybrid') => {
    const existing = meetings.find((m) => m.id === id);
    let targetUpdated: CampusMeeting | null = null;
    updateActiveMeetings((prev) =>
      prev.map((m) => {
        if (m.id !== id) return m;
        targetUpdated = {
          ...m,
          format,
          isOnline: format === 'online',
          rawLocation:
            format === 'online'
              ? 'Microsoft Teams'
              : `${m.buildingCode || 'MC'} ${m.roomNumber || ''}`,
        };
        return targetUpdated;
      })
    );

    if (
      activeSource === 'google' &&
      targetUpdated &&
      existing &&
      getGoogleAuthState().isConnected &&
      existing.googleEventId &&
      existing.questflowCreated
    ) {
      pendingGoogleWritesRef.current += 1;
      setGoogleError(null);
      updateGoogleEvent(targetUpdated)
        .catch((err: any) => {
          setGoogleError(err?.message || 'Could not update meeting in Google Calendar.');
        })
        .finally(() => {
          pendingGoogleWritesRef.current = Math.max(0, pendingGoogleWritesRef.current - 1);
        });
    }
  };

  // Navigation handler
  const handleSelectPage = (targetPage: AppPage) => {
    if (targetPage !== currentPage && currentPage !== 'connect') {
      setPreviousPage(currentPage);
    }
    setCurrentPage(targetPage);
  };

  return (
    <div className="min-h-screen bg-[var(--bg-main)] text-[var(--text-primary)] font-sans selection:bg-[var(--sky-strong)] selection:text-white flex flex-col">
      {/* Real-time departure reminder banner */}
      {activeDepartureAlert && (
        <div className="sticky top-0 z-50 bg-[var(--bg-card)] text-[var(--text-primary)] px-4 py-3 shadow-md border-b border-[var(--border)] flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[var(--sky-strong)] flex items-center justify-center shrink-0">
              <Bell className="w-4 h-4 text-white animate-bounce" />
            </div>
            <div>
              <p className="text-xs sm:text-sm font-bold text-[var(--text-primary)]">
                Time to Depart for {activeDepartureAlert.meetingTitle}!
              </p>
              <p className="text-xs text-[var(--text-secondary)]">
                Walk to {activeDepartureAlert.buildingCode} {activeDepartureAlert.roomNumber} takes ~{activeDepartureAlert.travelMinutes} mins to arrive on time for {activeDepartureAlert.departureTime}.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <a
              href={getGoogleMapsDirectionsUrl(
                activeDepartureAlert.originBuildingCode,
                activeDepartureAlert.buildingCode,
                'walking'
              )}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setActiveDepartureAlert(null)}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-[var(--sky-strong)] hover:bg-[var(--sky-hover)] rounded-lg transition-colors flex items-center gap-1.5 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sky-strong)]"
            >
              <Navigation className="w-3.5 h-3.5 text-white" />
              <span>Google Maps</span>
              <ExternalLink className="w-3 h-3 text-white opacity-85" />
            </a>
            <button
              type="button"
              aria-label="Dismiss departure reminder"
              onClick={() => setActiveDepartureAlert(null)}
              className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sky-strong)]"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Top Header App Navigation */}
      <PageStepper
        currentPage={currentPage}
        onSelectPage={handleSelectPage}
        hasMeetingsLoaded={meetings.length > 0}
        meetingCount={meetings.filter((m) => m.date === selectedDate).length}
        onOpenNewMeeting={handleOpenNewMeeting}
        onLoadSample={handleStartSampleWalkthrough}
      />

      {/* Main Multi-Page Container */}
      <main className="flex-1">
        {currentPage !== 'connect' && googleError && (
          <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-4">
            <div className="p-3.5 rounded-2xl bg-[var(--status-late-bg)] border border-[var(--status-late-fg)]/30 text-[var(--status-late-fg)] flex items-center justify-between gap-2.5 text-xs animate-in fade-in duration-150">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-[var(--status-late-fg)] shrink-0" />
                <span className="font-semibold">{googleError}</span>
              </div>
              <button
                type="button"
                onClick={() => setGoogleError(null)}
                className="p-1 rounded-lg text-[var(--status-late-fg)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                aria-label="Dismiss notice"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {currentPage === 'welcome' && (
          <WelcomeHeroPage
            onStartSampleWalkthrough={handleStartSampleWalkthrough}
            onOpenNextMeeting={() => {
              setIsNextUpOpen(true);
            }}
            onConnectCalendar={() => handleSelectPage('connect')}
          />
        )}

        {currentPage === 'connect' && (
          <ConnectCalendarPage
            currentMeetings={meetings}
            selectedDate={selectedDate}
            onSetMeetings={(newMeetings, isSample) => {
              if (isSample) {
                setTutorialMeetings(newMeetings);
                setActiveSource('tutorial');
                setSettings((prev) => ({
                  ...prev,
                  office: prev.office ?? SAMPLE_DEFAULT_OFFICE,
                }));
              } else {
                setTutorialMeetings([]);
                setFileMeetings(newMeetings);
                setActiveSource('file');
              }
            }}
            onActivateGoogleSource={() => {
              setTutorialMeetings([]);
              setActiveSource('google');
            }}
            onContinue={() => {
              setPreviousPage('connect');
              setCurrentPage('review');
            }}
            onBack={() => setCurrentPage(previousPage === 'review' ? 'review' : 'welcome')}
            googleAuthState={googleAuthState}
            isGoogleConfigured={isGoogleCalendarConfigured()}
            isGoogleBusy={isGoogleBusy}
            googleError={googleError}
            onClearGoogleError={() => setGoogleError(null)}
            onConnectGoogle={handleConnectGoogle}
            onDisconnectGoogle={handleDisconnectGoogle}
          />
        )}

        {currentPage === 'review' && (
          <CalendarReviewPage
            meetings={meetings}
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            onAddMeeting={handleOpenNewMeeting}
            onEditMeeting={handleOpenEditMeeting}
            onSaveMeeting={handleSaveMeeting}
            onDeleteMeeting={handleDeleteMeeting}
            onQuickToggleFormat={handleQuickToggleFormat}
            onOpenNextMeeting={() => setIsNextUpOpen(true)}
            onBackToConnect={() => handleSelectPage('connect')}
            settings={settings}
            onUpdateOffice={(office: UserOffice | null) =>
              setSettings((prev) => ({ ...prev, office }))
            }
            activeSource={activeSource}
            googleEmail={googleAuthState.email}
            onExitTutorial={handleExitTutorial}
          />
        )}
      </main>

      {/* Next Up Modal Box (dismissible with X, Escape, or backdrop tap) */}
      {isNextUpOpen && (
        <div
          className="fixed inset-0 z-50 bg-[var(--text-primary)]/45 backdrop-blur-xs flex items-start sm:items-center justify-center overflow-y-auto py-6 px-4 sm:px-16 animate-in fade-in duration-150"
          onClick={() => setIsNextUpOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Next Up Meetings"
        >
          <div
            ref={nextUpDialogRef}
            className="w-full max-w-xl relative my-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Top Close Row */}
            <div className="flex items-center justify-end mb-2.5">
              <button
                type="button"
                onClick={() => setIsNextUpOpen(false)}
                aria-label="Close Next Up"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--bg-card)] border border-[var(--border)] shadow-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sky-strong)]"
              >
                <X className="w-4 h-4" />
                <span>Close</span>
              </button>
            </div>

            <NextMeetingPage
              meetings={meetings}
              selectedDate={selectedDate}
              settings={settings}
              isModal={true}
              isFromCalendar={currentPage === 'review'}
              onClose={() => setIsNextUpOpen(false)}
              onOpenCalendar={() => {
                setCurrentPage('review');
                setIsNextUpOpen(false);
              }}
              onConnectCalendar={() => {
                setIsNextUpOpen(false);
                handleSelectPage('connect');
              }}
              onLoadSample={handleStartSampleWalkthrough}
            />
          </div>
        </div>
      )}

      {/* Add / Edit Meeting Modal */}
      <MeetingModal
        isOpen={isMeetingModalOpen}
        onClose={() => {
          setIsMeetingModalOpen(false);
          setMeetingToEdit(null);
        }}
        meetingToEdit={meetingToEdit}
        selectedDate={selectedDate}
        existingMeetings={meetings}
        settings={settings}
        onSaveMeeting={handleSaveMeeting}
        onDeleteMeeting={handleDeleteMeeting}
      />
    </div>
  );
}
