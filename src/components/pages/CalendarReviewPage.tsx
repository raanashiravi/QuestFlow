import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Calendar as CalendarIcon,
  MapPin,
  Plus,
  Trash2,
  Edit3,
  Video,
  ArrowRight,
  Navigation,
  ChevronDown,
  Footprints,
  Link2,
  Clock,
  History,
  ExternalLink,
  Zap,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  Check,
  Copy,
  X,
  Loader2,
  MessageSquare,
  MoreHorizontal,
} from 'lucide-react';
import {
  CampusMeeting,
  CampusSettings,
  OfficeReturnThreshold,
  TravelLeg,
  UserOffice,
} from '../../types';
import {
  calculateTravelLeg,
  getDepartureForMeeting,
  MeetingDepartureInfo,
  parseTimeToMinutes,
  formatMinutesToTime,
  formatTime12h,
  formatBuildingRoomLabel,
  isMeetingLocationUnknown,
  isMeetingOnline,
  needsCampusTravel,
} from '../../utils/travelCalculator';
import { UW_BUILDINGS } from '../../data/uwaterlooCampus';
import { findAvailableSlots, SuggestedSlot } from '../../utils/slotFinder';
import { getTodayLocalDateString } from '../../utils/icsParser';
import {
  getGoogleMapsBuildingUrl,
  getGoogleMapsDirectionsUrl,
} from '../../utils/googleMapsLinks';

const PIXELS_PER_MIN = 2.2; // 132px per hour

function formatTimeCompact(timeStr: string): string {
  if (!timeStr) return '';
  const [hStr, mStr] = timeStr.split(':');
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10) || 0;
  if (isNaN(h)) return timeStr;
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${m.toString().padStart(2, '0')}`;
}

function formatTimeRangePhone(startTime: string, endTime: string): string {
  if (!startTime || !endTime) return '';
  const [shStr] = startTime.split(':');
  const [ehStr] = endTime.split(':');
  const sh = parseInt(shStr, 10);
  const eh = parseInt(ehStr, 10);
  if (isNaN(sh) || isNaN(eh)) return `${formatTime12h(startTime)}–${formatTime12h(endTime)}`;
  const startPeriod = sh >= 12 ? 'PM' : 'AM';
  const endPeriod = eh >= 12 ? 'PM' : 'AM';
  if (startPeriod === endPeriod) {
    return `${formatTimeCompact(startTime)}–${formatTimeCompact(endTime)} ${endPeriod}`;
  }
  return `${formatTimeCompact(startTime)} ${startPeriod}–${formatTimeCompact(endTime)} ${endPeriod}`;
}

interface ProblemPair {
  id: string;
  earlier: CampusMeeting;
  later: CampusMeeting;
  leg: TravelLeg;
  isOverlap: boolean;
  targetMeeting: CampusMeeting;
  otherMeeting: CampusMeeting;
  badgeText: string;
}

function formatWrittenDate(dateStr: string): string {
  if (!dateStr) return '';
  const parsed = new Date(`${dateStr}T12:00:00`);
  if (isNaN(parsed.getTime())) return dateStr;
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(parsed);
}

function formatHourAxis(hour24: number): string {
  const normalized = ((hour24 % 24) + 24) % 24;
  if (normalized === 0) return '12 AM';
  if (normalized < 12) return `${normalized} AM`;
  if (normalized === 12) return '12 PM';
  return `${normalized - 12} PM`;
}

function formatDurationBadge(minutes: number): string {
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

interface PositionedMeeting {
  meeting: CampusMeeting;
  startMin: number;
  endMin: number;
  col: number;
  totalCols: number;
}

function layoutOverlappingMeetings(list: CampusMeeting[]): PositionedMeeting[] {
  if (list.length === 0) return [];

  const sorted = [...list]
    .map((meeting) => {
      const startMin = parseTimeToMinutes(meeting.startTime);
      const rawEnd = parseTimeToMinutes(meeting.endTime);
      const endMin = Math.max(startMin + 1, rawEnd);
      return { meeting, startMin, endMin };
    })
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  // Group into overlap clusters (meetings that only touch at startMin === maxEnd do not share a cluster)
  const clusters: { items: typeof sorted; maxEnd: number }[] = [];
  for (const item of sorted) {
    const lastCluster = clusters[clusters.length - 1];
    if (!lastCluster || item.startMin >= lastCluster.maxEnd) {
      clusters.push({ items: [item], maxEnd: item.endMin });
    } else {
      lastCluster.items.push(item);
      lastCluster.maxEnd = Math.max(lastCluster.maxEnd, item.endMin);
    }
  }

  const result: PositionedMeeting[] = [];
  for (const cluster of clusters) {
    const colEndTimes: number[] = [];
    const assigned: { item: (typeof sorted)[number]; col: number }[] = [];

    for (const item of cluster.items) {
      let colIdx = colEndTimes.findIndex((end) => end <= item.startMin);
      if (colIdx === -1) {
        colIdx = colEndTimes.length;
        colEndTimes.push(item.endMin);
      } else {
        colEndTimes[colIdx] = item.endMin;
      }
      assigned.push({ item, col: colIdx });
    }

    const totalCols = Math.max(1, colEndTimes.length);
    for (const entry of assigned) {
      result.push({
        meeting: entry.item.meeting,
        startMin: entry.item.startMin,
        endMin: entry.item.endMin,
        col: entry.col,
        totalCols,
      });
    }
  }

  return result;
}

interface CalendarReviewPageProps {
  meetings: CampusMeeting[];
  selectedDate: string;
  onSelectDate: (date: string) => void;
  onAddMeeting: () => void;
  onEditMeeting: (meeting: CampusMeeting) => void;
  onSaveMeeting?: (meeting: CampusMeeting) => void;
  onDeleteMeeting: (id: string) => void;
  onQuickToggleFormat: (id: string, format: 'in_person' | 'online' | 'hybrid') => void;
  onOpenNextMeeting: () => void;
  onBackToConnect: () => void;
  settings: CampusSettings;
  onUpdateOffice?: (office: UserOffice | null) => void;
  activeSource?: 'tutorial' | 'google' | 'file' | null;
  googleEmail?: string | null;
  onExitTutorial?: () => void;
}

export const CalendarReviewPage: React.FC<CalendarReviewPageProps> = ({
  meetings,
  selectedDate,
  onSelectDate,
  onAddMeeting,
  onEditMeeting,
  onSaveMeeting,
  onDeleteMeeting,
  onQuickToggleFormat,
  onOpenNextMeeting,
  onBackToConnect,
  settings,
  onUpdateOffice,
  activeSource,
  googleEmail,
  onExitTutorial,
}) => {
  const [filterFormat, setFilterFormat] = useState<'all' | 'in_person' | 'online' | 'hybrid'>('all');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [showPassedDropdown, setShowPassedDropdown] = useState<boolean>(false);
  const [openMenuMeetingId, setOpenMenuMeetingId] = useState<string | null>(null);

  // Office inline editor state
  const normalizeOfficeThreshold = (
    val?: OfficeReturnThreshold | number
  ): OfficeReturnThreshold => {
    if (val === 'never') return 'never';
    if (val === 30 || val === 45) return 45;
    if (val === 90) return 90;
    return 60;
  };

  const [isEditingOffice, setIsEditingOffice] = useState<boolean>(false);
  const [officeBuilding, setOfficeBuilding] = useState<string>(
    settings.office?.buildingCode || 'E7'
  );
  const [officeRoom, setOfficeRoom] = useState<string>(
    settings.office?.roomNumber || '2408'
  );
  const [officeReturnThreshold, setOfficeReturnThreshold] = useState<OfficeReturnThreshold>(
    normalizeOfficeThreshold(settings.office?.returnMinGapMinutes)
  );

  const handleOpenOfficeEditor = () => {
    setOfficeBuilding(settings.office?.buildingCode || 'E7');
    setOfficeRoom(settings.office?.roomNumber ?? '2408');
    setOfficeReturnThreshold(
      normalizeOfficeThreshold(settings.office?.returnMinGapMinutes)
    );
    setIsEditingOffice(true);
  };

  const handleSaveOffice = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedRoom = officeRoom.trim();
    const firstDigit = parseInt(trimmedRoom[0], 10);
    const floor = !isNaN(firstDigit) && firstDigit >= 1 && firstDigit <= 7 ? firstDigit : 1;
    onUpdateOffice?.({
      buildingCode: officeBuilding,
      roomNumber: trimmedRoom,
      floor,
      returnMinGapMinutes: officeReturnThreshold,
    });
    setIsEditingOffice(false);
  };

  const handleClearOffice = () => {
    onUpdateOffice?.(null);
    setIsEditingOffice(false);
  };

  // Measure schedule canvas width and phone viewport (< 640px)
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState<number>(640);
  const [isPhoneViewport, setIsPhoneViewport] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth < 640 : false
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = () => {
      setIsPhoneViewport(window.innerWidth < 640);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          setCanvasWidth(entry.contentRect.width);
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fix Sheet & Resolved Confirmation State
  const [activeFixProblem, setActiveFixProblem] = useState<ProblemPair | null>(null);
  const [fixDraftType, setFixDraftType] = useState<'later_start' | 'join_online' | null>(null);
  const [fixDraftText, setFixDraftText] = useState<string>('');
  const [isDraftingFix, setIsDraftingFix] = useState<boolean>(false);
  const [fixCopied, setFixCopied] = useState<boolean>(false);
  const [resolvedByMeetingId, setResolvedByMeetingId] = useState<Record<string, string>>({});
  const [fixedNotice, setFixedNotice] = useState<string | null>(null);
  const fixSheetRef = useRef<HTMLDivElement>(null);

  // Trap focus and close on Escape when the Fix sheet is open
  useEffect(() => {
    if (!activeFixProblem) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setActiveFixProblem(null);
      } else if (e.key === 'Tab' && fixSheetRef.current) {
        const focusable = fixSheetRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeFixProblem]);

  // Live time-of-day clock (updates every 15s)
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(timer);
  }, []);

  const todayStr = getTodayLocalDateString(now);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const currentTimeLabel = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(now);

  const isToday = selectedDate === todayStr;
  const isPastDate = selectedDate < todayStr;

  // Filter & sort all meetings for the selected date
  const dayMeetings = useMemo(
    () =>
      meetings
        .filter((m) => m.date === selectedDate)
        .sort((a, b) => a.startTime.localeCompare(b.startTime)),
    [meetings, selectedDate]
  );

  // Compute travel legs between physical/hybrid meetings across the full day
  // (when an online meeting sits between two in-person meetings, the walk is measured
  // from the earlier in-person building but can only start after the online meeting ends)
  const travelLegs = useMemo(() => {
    const legs: { [nextMeetingId: string]: TravelLeg } = {};
    let lastPhysical: CampusMeeting | null = null;

    for (let i = 0; i < dayMeetings.length - 1; i++) {
      const current = dayMeetings[i];
      if (isMeetingLocationUnknown(current)) {
        lastPhysical = null;
      } else if (needsCampusTravel(current)) {
        lastPhysical = current;
      }

      const next = dayMeetings[i + 1];
      if (lastPhysical && needsCampusTravel(next)) {
        legs[next.id] = calculateTravelLeg(lastPhysical, next, settings, current.endTime);
      }
    }
    return legs;
  }, [dayMeetings, settings]);

  // Build problem pairs & map each problem pair to the single meeting it targets
  const { impossibleLegs, problemLegs, problemPairs, problemByTargetId } = useMemo(() => {
    const orderedLegs: TravelLeg[] = [];
    const pairs: ProblemPair[] = [];
    const byTarget: Record<string, ProblemPair> = {};

    for (const m of dayMeetings) {
      const leg = travelLegs[m.id];
      if (!leg) continue;

      // On today's date, only count and offer fixes for transitions whose later meeting is still ahead
      if (isToday && parseTimeToMinutes(leg.toMeeting.startTime) <= currentMinutes) {
        continue;
      }

      orderedLegs.push(leg);

      if (leg.status === 'IMPOSSIBLE' || leg.status === 'LATE' || leg.status === 'TIGHT') {
        const earlier = leg.fromMeeting;
        const later = leg.toMeeting;
        const aIsUser = earlier.source === 'created' || earlier.source === 'new';
        const bIsUser = later.source === 'created' || later.source === 'new';

        // Target selection rule:
        // - If exactly one of A or B is user-created, target that one
        // - Otherwise target B
        const targetMeeting = aIsUser && !bIsUser ? earlier : later;
        const otherMeeting = targetMeeting.id === earlier.id ? later : earlier;
        const isOverlap = leg.gapMinutes < 0;

        const badgeText = isOverlap
          ? `Overlaps ${otherMeeting.title} (${formatTimeCompact(
              otherMeeting.startTime
            )}–${formatTimeCompact(otherMeeting.endTime)})`
          : `${leg.status === 'TIGHT' ? 'Tight' : 'Late'} · ${leg.questFlowTravelMinutes}m walk`;

        const pair: ProblemPair = {
          id: leg.id,
          earlier,
          later,
          leg,
          isOverlap,
          targetMeeting,
          otherMeeting,
          badgeText,
        };
        pairs.push(pair);
        if (!byTarget[targetMeeting.id]) {
          byTarget[targetMeeting.id] = pair;
        }
      }
    }

    return {
      impossibleLegs: orderedLegs.filter(
        (l) => l.status === 'IMPOSSIBLE' || l.status === 'LATE'
      ),
      problemLegs: orderedLegs.filter(
        (l) => l.status === 'IMPOSSIBLE' || l.status === 'LATE' || l.status === 'TIGHT'
      ),
      problemPairs: pairs,
      problemByTargetId: byTarget,
    };
  }, [dayMeetings, travelLegs, isToday, currentMinutes]);

  const handleOpenFixSheet = (problem: ProblemPair) => {
    setActiveFixProblem(problem);
    setFixDraftType(null);
    setFixDraftText('');
    setIsDraftingFix(false);
    setFixCopied(false);
  };

  const applyResolvedConfirmation = (meetingId: string, message: string) => {
    setResolvedByMeetingId((prev) => ({ ...prev, [meetingId]: message }));
    setFixedNotice(message);
    setActiveFixProblem(null);
  };

  const handleScrollToFirstProblem = () => {
    const firstPair = problemPairs[0];
    if (!firstPair) return;
    const targetId = firstPair.targetMeeting.id;
    const isInPassed = passedMeetings.some((m) => m.id === targetId);
    if (isInPassed && !showPassedDropdown) {
      setShowPassedDropdown(true);
    }
    setTimeout(() => {
      const el =
        document.getElementById(`transition-problem-${targetId}`) ||
        document.getElementById(`meeting-block-${targetId}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
  };

  // Compute departure info for every meeting using the shared getDepartureForMeeting helper
  const departureByMeetingId = useMemo(() => {
    const map: Record<string, MeetingDepartureInfo> = {};
    let lastPhysicalMeeting: CampusMeeting | null = null;

    for (const m of dayMeetings) {
      map[m.id] = getDepartureForMeeting(m, lastPhysicalMeeting, settings);
      if (isMeetingLocationUnknown(m)) {
        lastPhysicalMeeting = null;
      } else if (needsCampusTravel(m)) {
        lastPhysicalMeeting = m;
      }
    }
    return map;
  }, [dayMeetings, settings]);

  // First in-person meeting of the day & walk from office (when office is set)
  const firstInPersonMeeting = useMemo(
    () => dayMeetings.find((m) => needsCampusTravel(m)) || null,
    [dayMeetings]
  );

  const officeFirstWalk = useMemo(() => {
    if (!settings.office?.buildingCode || !firstInPersonMeeting) return null;
    const dep = departureByMeetingId[firstInPersonMeeting.id];
    if (!dep || !dep.hasOrigin || !dep.isViaOffice) return null;
    const bufferMinutes = settings.arrivalBufferMinutes ?? 5;
    const startMin = parseTimeToMinutes(firstInPersonMeeting.startTime);
    return {
      meetingId: firstInPersonMeeting.id,
      fromBuildingCode: settings.office.buildingCode,
      toBuildingCode: firstInPersonMeeting.buildingCode,
      walkMinutes: dep.walkMinutes,
      bufferMinutes,
      startMin,
      leaveByMin: dep.leaveByMinutes,
      leaveBy12h: dep.leaveByTime12h,
      label: `From office ${settings.office.buildingCode} → ${firstInPersonMeeting.buildingCode} · ${dep.walkMinutes}m walk · leave by ${dep.leaveByTime12h}`,
    };
  }, [settings, firstInPersonMeeting, departureByMeetingId]);

  const filteredMeetings = useMemo(
    () =>
      dayMeetings.filter((m) => {
        if (filterFormat === 'all') return true;
        const format = m.format || (m.isOnline ? 'online' : 'in_person');
        return format === filterFormat;
      }),
    [dayMeetings, filterFormat]
  );

  // Split into passed vs active/upcoming based on time of day
  const { passedMeetings, upcomingMeetings } = useMemo(() => {
    if (isPastDate) {
      return { passedMeetings: filteredMeetings, upcomingMeetings: [] as CampusMeeting[] };
    }
    if (!isToday) {
      return { passedMeetings: [] as CampusMeeting[], upcomingMeetings: filteredMeetings };
    }
    const passed: CampusMeeting[] = [];
    const upcoming: CampusMeeting[] = [];
    for (const m of filteredMeetings) {
      if (parseTimeToMinutes(m.endTime) <= currentMinutes) {
        passed.push(m);
      } else {
        upcoming.push(m);
      }
    }
    return { passedMeetings: passed, upcomingMeetings: upcoming };
  }, [filteredMeetings, isPastDate, isToday, currentMinutes]);

  // Live status summary for the time-of-day bar
  const liveStatusText = useMemo(() => {
    if (!isToday) return null;
    const inProgress = dayMeetings.find((m) => {
      const s = parseTimeToMinutes(m.startTime);
      const e = parseTimeToMinutes(m.endTime);
      return s <= currentMinutes && currentMinutes < e;
    });
    if (inProgress) {
      const left = parseTimeToMinutes(inProgress.endTime) - currentMinutes;
      return `In progress: ${inProgress.title} (${formatDurationBadge(left)} left)`;
    }
    const nextUp = dayMeetings.find((m) => parseTimeToMinutes(m.startTime) > currentMinutes);
    if (nextUp) {
      const until = parseTimeToMinutes(nextUp.startTime) - currentMinutes;
      return `Next: ${nextUp.title} at ${formatTime12h(nextUp.startTime)} (in ${formatDurationBadge(until)})`;
    }
    if (dayMeetings.length > 0) {
      return 'All meetings for today have ended';
    }
    return 'No meetings scheduled today';
  }, [isToday, dayMeetings, currentMinutes]);

  // Compute grid hours & positioned blocks for upcoming meetings
  const timelineLayout = useMemo(() => {
    if (upcomingMeetings.length === 0) return null;

    const positioned = layoutOverlappingMeetings(upcomingMeetings);
    const earliestStart = Math.min(...positioned.map((p) => p.startMin));
    const latestEnd = Math.max(...positioned.map((p) => p.endMin));

    // Build proportional travel blocks in gaps between consecutive upcoming meetings,
    // plus any remaining office trip after a passed meeting leading into the first upcoming meeting.
    const gapLegs: {
      leg: TravelLeg;
      topMin: number;
      gapMin: number;
      isOfficeTrip: boolean;
      minVisualHeightPx: number;
      showWalkToOffice?: boolean;
      showAtOffice?: boolean;
      showWalkFromOffice?: boolean;
      atOfficeStartTime12h?: string;
    }[] = [];

    const addOfficeTripLeg = (nxt: CampusMeeting, curEndMin: number) => {
      const leg = travelLegs[nxt.id];
      const nxtDep = departureByMeetingId[nxt.id];
      if (!leg || !nxtDep || !nxtDep.isOfficeReturnBetweenMeetings || !settings.office?.buildingCode) {
        return false;
      }

      const nxtStart = parseTimeToMinutes(nxt.startTime);
      if (nxtStart - curEndMin < 0) return false;
      if (isToday && currentMinutes >= nxtStart) return false;

      const officeArrivalMin = nxtDep.officeArrivalMinutes;
      const leaveByMin = nxtDep.leaveByMinutes;

      const showWalkToOffice = !isToday || currentMinutes < officeArrivalMin;
      const showAtOffice = !isToday || currentMinutes < leaveByMin;
      const showWalkFromOffice = !isToday || currentMinutes < nxtStart;

      if (!showWalkToOffice && !showAtOffice && !showWalkFromOffice) {
        return false;
      }

      const effectiveTopMin = showWalkToOffice
        ? isToday
          ? Math.max(curEndMin, currentMinutes)
          : curEndMin
        : showAtOffice
        ? isToday
          ? Math.max(officeArrivalMin, currentMinutes)
          : officeArrivalMin
        : isToday
        ? Math.max(leaveByMin, currentMinutes)
        : leaveByMin;

      const effectiveAtOfficeStartMin = isToday
        ? Math.max(currentMinutes, officeArrivalMin)
        : officeArrivalMin;
      const atOfficeStartTime12h =
        isToday && currentMinutes > officeArrivalMin
          ? formatTime12h(formatMinutesToTime(effectiveAtOfficeStartMin))
          : nxtDep.officeArrivalTime12h;

      const visibleParts =
        (showWalkToOffice ? 1 : 0) +
        (showAtOffice ? 1 : 0) +
        (showWalkFromOffice ? 1 : 0);
      const minVisualHeightPx = isPhoneViewport
        ? visibleParts === 3
          ? 144
          : visibleParts === 2
          ? 96
          : 48
        : visibleParts === 3
        ? 96
        : visibleParts === 2
        ? 64
        : 30;

      gapLegs.push({
        leg,
        topMin: effectiveTopMin,
        gapMin: Math.max(0, nxtStart - effectiveTopMin),
        isOfficeTrip: true,
        minVisualHeightPx,
        showWalkToOffice,
        showAtOffice,
        showWalkFromOffice,
        atOfficeStartTime12h,
      });
      return true;
    };

    // If the earlier meeting has already ended (in passedMeetings) but an office trip
    // before the first upcoming meeting is still in progress or ahead, include the remaining part
    if (passedMeetings.length > 0 && upcomingMeetings.length > 0) {
      const firstUpcoming = upcomingMeetings[0];
      const incomingLeg = travelLegs[firstUpcoming.id];
      if (incomingLeg) {
        const earlierEndMin = parseTimeToMinutes(incomingLeg.fromMeeting.endTime);
        addOfficeTripLeg(firstUpcoming, earlierEndMin);
      }
    }

    for (let i = 0; i < upcomingMeetings.length - 1; i++) {
      const cur = upcomingMeetings[i];
      const nxt = upcomingMeetings[i + 1];
      const leg = travelLegs[nxt.id];
      const nxtDep = departureByMeetingId[nxt.id];
      if (!leg) continue;

      const curEnd = parseTimeToMinutes(cur.endTime);
      const nxtStart = parseTimeToMinutes(nxt.startTime);
      const gapMin = nxtStart - curEnd;

      // Never draw a walk row when two meetings overlap in time
      if (gapMin < 0) continue;

      const isOfficeTrip = Boolean(
        nxtDep?.isOfficeReturnBetweenMeetings && settings.office?.buildingCode
      );
      if (isOfficeTrip) {
        addOfficeTripLeg(nxt, curEnd);
        continue;
      }

      const isShortLateGap =
        (leg.status === 'IMPOSSIBLE' || leg.status === 'LATE') &&
        gapMin >= 0 &&
        gapMin < 5;

      if (leg.isSameBuilding && !isShortLateGap) continue;

      gapLegs.push({
        leg,
        topMin: curEnd,
        gapMin,
        isOfficeTrip: false,
        minVisualHeightPx: isPhoneViewport ? 48 : 30,
      });
    }

    const includeNowInGrid =
      isToday &&
      currentMinutes >= earliestStart - 120 &&
      currentMinutes <= latestEnd + 60;

    const hasOfficeFirstInUpcoming = Boolean(
      officeFirstWalk &&
        upcomingMeetings.some((m) => m.id === officeFirstWalk.meetingId)
    );
    const officeRowTopMin =
      hasOfficeFirstInUpcoming && officeFirstWalk
        ? officeFirstWalk.startMin - Math.max(isPhoneViewport ? 22 : 18, officeFirstWalk.walkMinutes + officeFirstWalk.bufferMinutes)
        : earliestStart;

    const earliestGapTopMin =
      gapLegs.length > 0
        ? Math.min(...gapLegs.map((g) => g.topMin))
        : earliestStart;

    const minMinute = Math.min(
      includeNowInGrid ? Math.min(earliestStart, currentMinutes) : earliestStart,
      officeRowTopMin,
      earliestGapTopMin
    );
    const maxMinute = includeNowInGrid
      ? Math.max(latestEnd, currentMinutes + 20)
      : latestEnd;

    const startHour = Math.max(0, Math.floor(minMinute / 60));
    const endHour = Math.min(24, Math.max(startHour + 2, Math.ceil(maxMinute / 60)));

    const gridStartMin = startHour * 60;
    const gridEndMin = endHour * 60;

    const hours: number[] = [];
    for (let h = startHour; h <= endHour; h++) {
      hours.push(h);
    }

    // Group positioned cards by overlap cluster so side-by-side short cards don't double-push vertically,
    // while stacked short cards shift the next card down just enough so neither is hidden.
    const cardPaddingIntervals: { startMin: number; endMin: number; extraPx: number }[] = [];
    for (const p of positioned) {
      const naturalCardPx = (p.endMin - p.startMin) * PIXELS_PER_MIN;
      const isInProgressCard =
        isToday && p.startMin <= currentMinutes && currentMinutes < p.endMin;
      const hasLine3OnPhone =
        isPhoneViewport &&
        (isInProgressCard ||
          Boolean(problemByTargetId[p.meeting.id]) ||
          Boolean(resolvedByMeetingId[p.meeting.id]));
      const minRequiredCardPx = isPhoneViewport
        ? hasLine3OnPhone
          ? 114
          : 74
        : 54;
      const extraCardPx = Math.max(0, minRequiredCardPx - naturalCardPx);
      if (extraCardPx <= 0) continue;
      const last = cardPaddingIntervals[cardPaddingIntervals.length - 1];
      if (last && p.startMin < last.endMin) {
        last.endMin = Math.max(last.endMin, p.endMin);
        last.extraPx = Math.max(last.extraPx, extraCardPx);
      } else {
        cardPaddingIntervals.push({
          startMin: p.startMin,
          endMin: p.endMin,
          extraPx: extraCardPx,
        });
      }
    }

    // Monotonic push-down offset so walk rows and meeting cards never overlap
    const getOffsetAtMin = (min: number, includeZeroGapsAtMin = true): number => {
      let offset = 0;
      for (const c of cardPaddingIntervals) {
        if (min >= c.endMin) {
          offset += c.extraPx;
        } else if (min > c.startMin) {
          offset += c.extraPx * ((min - c.startMin) / Math.max(1, c.endMin - c.startMin));
        }
      }
      for (const g of gapLegs) {
        const naturalGapPx = Math.max(0, g.gapMin) * PIXELS_PER_MIN;
        const extraGapPx = Math.max(0, g.minVisualHeightPx - naturalGapPx);
        if (extraGapPx <= 0) continue;
        if (g.gapMin <= 0) {
          if (min > g.topMin || (includeZeroGapsAtMin && min === g.topMin)) {
            offset += extraGapPx;
          }
        } else if (min > g.topMin) {
          if (min >= g.topMin + g.gapMin) {
            offset += extraGapPx;
          } else {
            offset += extraGapPx * ((min - g.topMin) / g.gapMin);
          }
        }
      }
      return offset;
    };

    const getTopPxForMin = (min: number, includeZeroGapsAtMin = true): number =>
      (min - gridStartMin) * PIXELS_PER_MIN + 12 + getOffsetAtMin(min, includeZeroGapsAtMin);

    const totalHeight =
      (gridEndMin - gridStartMin) * PIXELS_PER_MIN + getOffsetAtMin(gridEndMin, true);

    return {
      positioned,
      hours,
      startHour,
      endHour,
      gridStartMin,
      gridEndMin,
      totalHeight,
      gapLegs,
      hasOfficeFirstInUpcoming,
      getTopPxForMin,
    };
  }, [
    passedMeetings,
    upcomingMeetings,
    isToday,
    currentMinutes,
    travelLegs,
    officeFirstWalk,
    departureByMeetingId,
    settings.office,
    isPhoneViewport,
    problemByTargetId,
    resolvedByMeetingId,
  ]);

  const writtenDate = formatWrittenDate(selectedDate);

  // Compact block renderer for Passed Meetings inside the collapsible dropdown
  const renderPassedBlock = (meeting: CampusMeeting) => {
    const format = meeting.format || (meeting.isOnline ? 'online' : 'in_person');
    const isOnline = isMeetingOnline(meeting);
    const isLocationUnknown = isMeetingLocationUnknown(meeting);
    const incomingLeg = travelLegs[meeting.id];
    const targetProblem = isToday ? undefined : problemByTargetId[meeting.id];
    const isResolved = Boolean(resolvedByMeetingId[meeting.id]);
    const isTight = targetProblem?.leg.status === 'TIGHT';
    const wasLateToday =
      isToday &&
      !isResolved &&
      Boolean(
        incomingLeg && (incomingLeg.status === 'IMPOSSIBLE' || incomingLeg.status === 'LATE')
      );

    const mapsUrl =
      !isOnline && !isLocationUnknown
        ? getGoogleMapsBuildingUrl(meeting.buildingCode)
        : '';

    const showOfficeWalkRow =
      officeFirstWalk && officeFirstWalk.meetingId === meeting.id;
    const isMenuOpen = openMenuMeetingId === meeting.id;
    const locCompact = isOnline
      ? 'Teams'
      : isLocationUnknown
      ? 'Set location'
      : `${meeting.buildingCode}${meeting.roomNumber ? ` ${meeting.roomNumber}` : ''}`;
    const phoneTimeAndPlace = `${formatTimeRangePhone(
      meeting.startTime,
      meeting.endTime
    )} · ${locCompact}`;
    const hasPassedLine3 = Boolean(wasLateToday || targetProblem || isResolved);

    return (
      <div className="space-y-1.5" id={`meeting-block-${meeting.id}`}>
        {showOfficeWalkRow && officeFirstWalk && (
          <div className="px-3 py-1.5 rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] text-[13px] sm:text-[11px] font-bold flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <Footprints className="w-4 h-4 sm:w-3.5 sm:h-3.5 shrink-0 text-[var(--sky)]" />
              {isPhoneViewport ? (
                <div className="min-w-0 leading-tight">
                  <div className="truncate">
                    {officeFirstWalk.fromBuildingCode} → {officeFirstWalk.toBuildingCode} · {officeFirstWalk.walkMinutes}m
                  </div>
                  <div className="text-[13px] text-[var(--text-secondary)] font-semibold truncate">
                    leave by {officeFirstWalk.leaveBy12h}
                  </div>
                </div>
              ) : (
                <span className="truncate">{officeFirstWalk.label}</span>
              )}
            </div>
            <a
              href={getGoogleMapsDirectionsUrl(
                officeFirstWalk.fromBuildingCode,
                officeFirstWalk.toBuildingCode,
                'walking'
              )}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Route"
              className="inline-flex items-center justify-center gap-1 min-w-[40px] min-h-[40px] sm:min-w-0 sm:min-h-0 px-2 py-0.5 rounded-md bg-[var(--bg-main)] border border-[var(--border)] text-[var(--sky-strong)] hover:bg-[var(--sky-strong)] hover:text-white text-[13px] sm:text-[10px] font-bold shadow-2xs transition-colors shrink-0"
              title="Open walking directions from office in Google Maps"
            >
              <Navigation className="w-4 h-4 sm:w-2.5 sm:h-2.5" />
              <span className="hidden sm:inline">Route</span>
              <ExternalLink className="hidden sm:inline w-2 h-2 opacity-75" />
            </a>
          </div>
        )}
        {isPhoneViewport ? (
          <div
            onClick={() => onEditMeeting(meeting)}
            className={`px-3 py-2.5 rounded-xl border relative cursor-pointer flex items-start justify-between gap-2 ${
              hasPassedLine3 ? 'min-h-[112px]' : 'min-h-[72px]'
            } ${
              format === 'online'
                ? 'bg-[var(--bg-card)] border-[var(--border)] border-l-4 border-l-[var(--oatmeal)] text-[var(--text-primary)]'
                : 'bg-[var(--sky-tint)] border-[var(--border)] border-l-4 border-l-[var(--sky)] text-[var(--sky-strong)]'
            }`}
          >
            <div className="min-w-0 flex-1 flex flex-col justify-between">
              <div className="min-w-0">
                <p
                  className={`text-[13px] font-extrabold line-clamp-2 leading-tight ${
                    format === 'online' ? 'text-[var(--text-primary)]' : 'text-[var(--sky-strong)]'
                  }`}
                >
                  {meeting.title}
                </p>
                <p
                  className={`text-[13px] font-semibold truncate mt-0.5 tabular-nums ${
                    format === 'online' ? 'text-[var(--text-secondary)]' : 'text-[var(--sky-strong)]'
                  }`}
                >
                  {phoneTimeAndPlace}
                </p>
              </div>
              {hasPassedLine3 && (
                <div
                  className="flex items-center gap-1.5 flex-nowrap mt-1.5 min-w-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  {wasLateToday && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-secondary)] text-[13px] font-semibold shrink-0">
                      <Clock className="w-3.5 h-3.5 shrink-0" />
                      <span>Was late</span>
                    </span>
                  )}
                  {targetProblem && (
                    <span
                      id={`transition-problem-${meeting.id}`}
                      className="inline-flex items-center gap-1.5 min-w-0"
                    >
                      <span
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[13px] font-extrabold truncate ${
                          isTight
                            ? 'bg-[var(--status-tight-bg)] text-[var(--status-tight-fg)]'
                            : 'bg-[var(--status-late-bg)] text-[var(--status-late-fg)]'
                        }`}
                      >
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{targetProblem.badgeText}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => handleOpenFixSheet(targetProblem)}
                        className={`inline-flex items-center justify-center min-h-[40px] px-2.5 py-1 rounded-lg text-white text-[13px] font-extrabold shadow-2xs transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sky-strong)] ${
                          isTight
                            ? 'bg-[var(--status-tight-fg)] hover:opacity-90'
                            : 'bg-[var(--status-late-fg)] hover:opacity-90'
                        }`}
                      >
                        Fix this
                      </button>
                    </span>
                  )}
                  {!targetProblem && isResolved && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--status-ok-bg)] text-[var(--status-ok-fg)] text-[13px] font-extrabold shrink-0">
                      <Check className="w-3.5 h-3.5" />
                      <span>Fixed</span>
                    </span>
                  )}
                </div>
              )}
            </div>
            <div
              className="relative shrink-0 -mt-1 -mr-1"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => setOpenMenuMeetingId(isMenuOpen ? null : meeting.id)}
                aria-label="More actions"
                className="inline-flex items-center justify-center min-w-[40px] min-h-[40px] p-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer text-[15px] font-bold leading-none"
              >
                ⋯
              </button>
              {isMenuOpen && (
                <div className="absolute right-0 top-10 w-44 rounded-xl bg-[var(--bg-card)] border border-[var(--border)] shadow-xl py-1 z-40 text-[13px] font-semibold">
                  {!isOnline && !isLocationUnknown && (
                    <a
                      href={mapsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setOpenMenuMeetingId(null)}
                      className="flex items-center gap-2 min-h-[40px] px-3 py-2 text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                    >
                      <Navigation className="w-4 h-4 text-[var(--sky)]" />
                      <span>Open in Maps</span>
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      onQuickToggleFormat(meeting.id, isOnline ? 'in_person' : 'online');
                      setOpenMenuMeetingId(null);
                    }}
                    className="w-full flex items-center gap-2 min-h-[40px] px-3 py-2 text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
                  >
                    <Video className="w-4 h-4 text-[var(--sky)]" />
                    <span>{isOnline ? 'Switch to Campus' : 'Switch to Teams'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenuMeetingId(null);
                      onEditMeeting(meeting);
                    }}
                    className="w-full flex items-center gap-2 min-h-[40px] px-3 py-2 text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
                  >
                    <Edit3 className="w-4 h-4 text-[var(--text-muted)]" />
                    <span>Edit</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenuMeetingId(null);
                      onDeleteMeeting(meeting.id);
                    }}
                    className="w-full flex items-center gap-2 min-h-[40px] px-3 py-2 text-left text-[var(--status-late-fg)] hover:bg-[var(--status-late-bg)] cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                    <span>Delete</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
        <div
          className={`px-3.5 py-2.5 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${
            format === 'online'
              ? 'bg-[var(--bg-card)] border-[var(--border)] border-l-4 border-l-[var(--oatmeal)] text-[var(--text-primary)]'
              : 'bg-[var(--sky-tint)] border-[var(--border)] border-l-4 border-l-[var(--sky)] text-[var(--sky-strong)]'
          }`}
        >
        <div className="flex items-center gap-3 min-w-0">
          <div className={`text-xs font-bold tabular-nums shrink-0 w-32 ${format === 'online' ? 'text-[var(--text-muted)]' : 'text-[var(--sky-strong)]'}`}>
            {formatTime12h(meeting.startTime)} – {formatTime12h(meeting.endTime)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className={`text-xs sm:text-sm font-bold truncate ${format === 'online' ? 'text-[var(--text-primary)]' : 'text-[var(--sky-strong)]'}`}>
                {meeting.title}
              </p>
              {wasLateToday && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-secondary)] text-[10px] font-semibold shrink-0">
                  <Clock className="w-2.5 h-2.5 shrink-0" />
                  <span>Was late</span>
                </span>
              )}
              {targetProblem && (
                <span
                  id={`transition-problem-${meeting.id}`}
                  className="inline-flex items-center gap-1 shrink-0"
                >
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-extrabold ${
                      targetProblem.isOverlap ? '' : 'uppercase'
                    } ${
                      isTight
                        ? 'bg-[var(--status-tight-bg)] text-[var(--status-tight-fg)]'
                        : 'bg-[var(--status-late-bg)] text-[var(--status-late-fg)]'
                    }`}
                  >
                    <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
                    <span>{targetProblem.badgeText}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => handleOpenFixSheet(targetProblem)}
                    className={`px-2 py-0.5 rounded text-white text-[10px] font-extrabold shadow-2xs transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sky-strong)] ${
                      isTight
                        ? 'bg-[var(--status-tight-fg)] hover:opacity-90'
                        : 'bg-[var(--status-late-fg)] hover:opacity-90'
                    }`}
                  >
                    Fix this
                  </button>
                </span>
              )}
              {!targetProblem && isResolved && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--status-ok-bg)] text-[var(--status-ok-fg)] text-[10px] font-extrabold uppercase shrink-0">
                  <Check className="w-2.5 h-2.5" />
                  <span>Fixed</span>
                </span>
              )}
            </div>
            <p className={`text-[11px] flex items-center gap-1 ${format === 'online' ? 'text-[var(--text-muted)]' : 'text-[var(--sky-strong)]'}`}>
              {isOnline ? (
                <>
                  <Video className="w-3 h-3 text-[var(--sky)] shrink-0" />
                  <span>Teams</span>
                </>
              ) : isLocationUnknown ? (
                <>
                  <MapPin className="w-3 h-3 text-[var(--status-tight-fg)] shrink-0" />
                  <span className="text-[var(--status-tight-fg)] font-semibold">Set location</span>
                </>
              ) : (
                <>
                  <MapPin className="w-3 h-3 text-[var(--sky)] shrink-0" />
                  <span>
                    {meeting.buildingCode}
                    {meeting.roomNumber ? ` ${meeting.roomNumber}` : ''}
                    {format === 'hybrid' ? ' / Teams' : ''}
                  </span>
                </>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 self-end sm:self-center shrink-0">
          {!isOnline && !isLocationUnknown && (
            <a
              href={mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-[var(--border)] bg-[var(--bg-main)] text-[var(--sky-strong)] hover:bg-[var(--sky-strong)] hover:text-white text-[11px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sky-strong)]"
              title={`Open ${meeting.buildingCode} in Google Maps`}
            >
              <Navigation className="w-3 h-3 shrink-0" />
              <span>Maps</span>
            </a>
          )}

          <button
            type="button"
            onClick={() => onEditMeeting(meeting)}
            className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--sky-strong)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sky-strong)]"
            title="Edit Meeting"
            aria-label="Edit meeting"
          >
            <Edit3 className="w-3.5 h-3.5" />
          </button>

          {deleteConfirmId === meeting.id ? (
            <div className="flex items-center gap-1 bg-[var(--status-late-bg)] p-0.5 rounded-lg border border-[var(--status-late-fg)]/30">
              <button
                type="button"
                onClick={() => {
                  onDeleteMeeting(meeting.id);
                  setDeleteConfirmId(null);
                }}
                className="px-2 py-0.5 text-xs font-bold text-white bg-[var(--status-late-fg)] rounded cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--status-late-fg)]"
                aria-label="Confirm delete meeting"
              >
                Del
              </button>
              <button
                type="button"
                onClick={() => setDeleteConfirmId(null)}
                className="px-1.5 py-0.5 text-xs text-[var(--text-secondary)] rounded cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sky-strong)]"
                aria-label="Cancel delete"
              >
                ✕
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setDeleteConfirmId(meeting.id)}
              className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--status-late-fg)] hover:bg-[var(--status-late-bg)] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--status-late-fg)]"
              title="Delete Meeting"
              aria-label="Delete meeting"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      )}
    </div>
  );
  };

  const showNowLine =
    isToday &&
    timelineLayout &&
    currentMinutes >= timelineLayout.gridStartMin &&
    currentMinutes <= timelineLayout.gridEndMin;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6 animate-in fade-in duration-200">
      {/* Header */}
      <div className="space-y-2 pb-3 border-b border-[var(--border)]">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-[var(--text-primary)]">
              Your Calendar
            </h1>
            {isToday ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--sky-strong)] text-white text-xs font-bold tabular-nums">
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                <span>{currentTimeLabel}</span>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onSelectDate(todayStr)}
                className="px-2.5 py-1 rounded-lg bg-[var(--sky-strong)] hover:bg-[var(--sky-hover)] text-xs font-semibold text-white transition-colors cursor-pointer"
              >
                Jump to Today
              </button>
            )}

            {dayMeetings.length > 0 && (
              impossibleLegs.length > 0 ? (
                <button
                  type="button"
                  onClick={handleScrollToFirstProblem}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--status-late-bg)] hover:opacity-90 border border-[var(--status-late-fg)]/30 text-xs font-bold text-[var(--status-late-fg)] transition-colors cursor-pointer"
                >
                  <AlertTriangle className="w-3.5 h-3.5 text-[var(--status-late-fg)] shrink-0" />
                  <span>
                    {impossibleLegs.length} back-to-back{impossibleLegs.length === 1 ? '' : 's'} you can&apos;t make
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={problemLegs.length > 0 ? handleScrollToFirstProblem : undefined}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--status-ok-bg)] border border-[var(--status-ok-fg)]/30 text-xs font-bold text-[var(--status-ok-fg)] transition-colors ${
                    problemLegs.length > 0 ? 'cursor-pointer hover:opacity-90' : 'cursor-default'
                  }`}
                >
                  <CheckCircle2 className="w-3.5 h-3.5 text-[var(--status-ok-fg)] shrink-0" />
                  <span>All meetings reachable</span>
                </button>
              )
            )}
          </div>
        </div>

        {activeSource && (
          <div>
            {activeSource === 'tutorial' ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-xs font-semibold text-[var(--text-secondary)]">
                <span>Tutorial ·</span>
                <button
                  type="button"
                  onClick={onExitTutorial}
                  className="font-bold text-[var(--sky-strong)] hover:underline cursor-pointer focus-visible:outline-none"
                >
                  Exit tutorial
                </button>
              </span>
            ) : activeSource === 'google' ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-xs font-semibold text-[var(--text-secondary)]">
                <span>
                  Google Calendar{googleEmail ? ` · ${googleEmail}` : ''}
                </span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-xs font-semibold text-[var(--text-secondary)]">
                <span>Imported file</span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Fixed Confirmation Notice */}
      {fixedNotice && (
        <div className="p-3.5 rounded-2xl bg-[var(--status-ok-bg)] border border-[var(--status-ok-fg)]/30 text-[var(--status-ok-fg)] flex items-center justify-between gap-2.5 text-xs animate-in fade-in duration-150">
          <div className="flex items-center gap-2">
            <Check className="w-4 h-4 text-[var(--status-ok-fg)] shrink-0" />
            <span className="font-semibold">Fixed · {fixedNotice}</span>
          </div>
          <button
            type="button"
            onClick={() => setFixedNotice(null)}
            className="p-1 rounded-lg text-[var(--status-ok-fg)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
            aria-label="Dismiss notice"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Prominent Written-Out Date, Office Chip & Filter Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative inline-flex items-center gap-2.5 group w-fit">
            <div className="p-2 rounded-xl bg-[var(--sky-tint)] border border-[var(--sky)] text-[var(--sky-strong)]">
              <CalendarIcon className="w-5 h-5" />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-lg sm:text-2xl font-extrabold tracking-tight text-[var(--text-primary)] group-hover:text-[var(--sky-strong)] transition-colors">
                {writtenDate}
              </span>
              <ChevronDown className="w-4 h-4 text-[var(--sky)] group-hover:text-[var(--sky-strong)] transition-colors shrink-0" />
            </div>
            <input
              type="date"
              aria-label="Select date"
              value={selectedDate}
              onChange={(e) => {
                if (e.target.value) onSelectDate(e.target.value);
              }}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>

          {!isEditingOffice ? (
            <button
              type="button"
              onClick={handleOpenOfficeEditor}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--bg-card)] hover:bg-[var(--bg-hover)] border border-[var(--border)] text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--sky-strong)] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sky-strong)]"
            >
              <span>
                {settings.office?.buildingCode
                  ? `🏢 Office: ${settings.office.buildingCode}${
                      settings.office.roomNumber ? ` ${settings.office.roomNumber}` : ''
                    } ✎`
                  : '🏢 Set your office'}
              </span>
            </button>
          ) : (
            <form
              onSubmit={handleSaveOffice}
              className="inline-flex flex-wrap items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-[var(--bg-card)] border border-[var(--sky)] shadow-xs text-xs"
            >
              <span className="font-semibold text-[var(--text-secondary)]">🏢</span>
              <select
                aria-label="Office building"
                value={officeBuilding}
                onChange={(e) => setOfficeBuilding(e.target.value)}
                className="px-2 py-1 rounded-lg bg-[var(--bg-main)] border border-[var(--border)] font-bold text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--sky-strong)]"
              >
                {Object.keys(UW_BUILDINGS).map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
              <input
                type="text"
                aria-label="Office room"
                value={officeRoom}
                onChange={(e) => setOfficeRoom(e.target.value)}
                placeholder="Room"
                className="w-16 px-2 py-1 rounded-lg bg-[var(--bg-main)] border border-[var(--border)] font-semibold text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--sky-strong)]"
              />
              <label className="inline-flex items-center gap-1 text-[var(--text-secondary)] font-medium">
                <span>Go back to my office when I have at least</span>
                <select
                  aria-label="Go back to my office when I have at least"
                  value={officeReturnThreshold}
                  onChange={(e) => {
                    const val = e.target.value;
                    setOfficeReturnThreshold(
                      val === 'never' ? 'never' : (Number(val) as OfficeReturnThreshold)
                    );
                  }}
                  className="px-1.5 py-1 rounded-lg bg-[var(--bg-main)] border border-[var(--border)] font-bold text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--sky-strong)]"
                >
                  <option value={45}>45 min</option>
                  <option value={60}>60 min</option>
                  <option value={90}>90 min</option>
                  <option value="never">Never</option>
                </select>
                <span>free</span>
              </label>
              <button
                type="submit"
                className="px-2.5 py-1 rounded-lg bg-[var(--sky-strong)] hover:bg-[var(--sky-hover)] text-white font-bold transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sky-strong)]"
              >
                Save
              </button>
              <button
                type="button"
                onClick={handleClearOffice}
                className="px-2 py-1 rounded-lg bg-[var(--bg-main)] hover:bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-secondary)] font-semibold transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sky-strong)]"
              >
                Clear
              </button>
            </form>
          )}
        </div>

        <div className="flex items-center gap-1 bg-[var(--bg-card)] border border-[var(--border)] p-1 rounded-xl text-xs font-semibold self-start sm:self-auto">
          <button
            type="button"
            onClick={() => setFilterFormat('all')}
            className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer ${
              filterFormat === 'all'
                ? 'bg-[var(--sky-strong)] text-white shadow-2xs'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            All ({dayMeetings.length})
          </button>
          <button
            type="button"
            onClick={() => setFilterFormat('in_person')}
            className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer ${
              filterFormat === 'in_person'
                ? 'bg-[var(--sky-strong)] text-white shadow-2xs'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            Campus ({dayMeetings.filter((m) => m.format === 'in_person' || (!m.format && !m.isOnline)).length})
          </button>
          <button
            type="button"
            onClick={() => setFilterFormat('online')}
            className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer ${
              filterFormat === 'online'
                ? 'bg-[var(--sky-strong)] text-white shadow-2xs'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            Online ({dayMeetings.filter((m) => m.format === 'online' || (!m.format && m.isOnline)).length})
          </button>
        </div>
      </div>

      {/* Collapsible Dropdown Menu for Passed Time Blocks */}
      {passedMeetings.length > 0 && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
          <button
            type="button"
            onClick={() => setShowPassedDropdown((prev) => !prev)}
            aria-expanded={showPassedDropdown}
            className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-[var(--bg-hover)] text-[var(--text-secondary)] flex items-center justify-center shrink-0">
                <History className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs sm:text-sm font-bold text-[var(--text-primary)]">
                    {isToday ? 'Earlier Today' : 'Passed Meetings'} ({passedMeetings.length})
                  </span>
                  <span className="text-[11px] font-medium text-[var(--text-muted)] tabular-nums hidden sm:inline">
                    {formatTime12h(passedMeetings[0].startTime)} –{' '}
                    {formatTime12h(passedMeetings[passedMeetings.length - 1].endTime)}
                  </span>
                </div>
                <p className="text-[11px] text-[var(--text-muted)] truncate">
                  {showPassedDropdown
                    ? 'Click to hide completed time blocks'
                    : 'Hidden because their time blocks have passed — click to view'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-secondary)] shrink-0">
              <span>{showPassedDropdown ? 'Hide' : 'Show'}</span>
              <ChevronDown
                className={`w-4 h-4 transition-transform duration-200 ${
                  showPassedDropdown ? 'rotate-180' : ''
                }`}
              />
            </div>
          </button>

          {showPassedDropdown && (
            <div className="px-3 pb-3 pt-1.5 border-t border-[var(--border)] space-y-2">
              {passedMeetings.map((meeting) => (
                <div key={meeting.id}>{renderPassedBlock(meeting)}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Clickable Blue Current-Time / Next-Up Strip */}
      {dayMeetings.length > 0 && (
        <button
          type="button"
          onClick={onOpenNextMeeting}
          className="w-full flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-[var(--sky-tint)] hover:bg-[var(--bg-hover)] border border-[var(--sky)] text-xs transition-colors cursor-pointer group text-left shadow-2xs"
        >
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex items-center gap-1.5 font-bold text-[var(--sky-strong)] shrink-0 tabular-nums">
              <Clock className="w-3.5 h-3.5" />
              <span>{isToday ? `Now · ${currentTimeLabel}` : 'Schedule'}</span>
            </div>
            <span className="text-[var(--sky)] shrink-0">·</span>
            <span className="font-semibold text-[var(--text-primary)] truncate">
              {isToday && liveStatusText
                ? liveStatusText
                : `${dayMeetings.length} meeting${dayMeetings.length === 1 ? '' : 's'} scheduled`}
            </span>
          </div>

          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--sky-strong)] group-hover:bg-[var(--sky-hover)] text-white text-[11px] font-extrabold shrink-0 shadow-2xs transition-colors">
            <Zap className="w-3 h-3" />
            <span>Next Up</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </span>
        </button>
      )}

      {/* Proportional Time-Block Calendar Grid */}
      <div>
        {filteredMeetings.length === 0 ? (
          <div className="text-center py-10 px-4 rounded-2xl border-2 border-dashed border-[var(--border)] bg-[var(--bg-card)]">
            <CalendarIcon className="w-9 h-9 mx-auto text-[var(--sky)] mb-2" />
            <h3 className="text-sm font-bold text-[var(--text-primary)]">
              No meetings on {writtenDate}
            </h3>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
              <button
                type="button"
                onClick={onAddMeeting}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-extrabold bg-[var(--sky-strong)] text-white hover:bg-[var(--sky-hover)] shadow-md transition-all cursor-pointer active:scale-95"
              >
                <Plus className="w-4 h-4 stroke-[2.5]" />
                <span>Add Meeting</span>
              </button>
              <button
                type="button"
                onClick={onBackToConnect}
                className="px-4 py-2.5 rounded-xl text-sm font-semibold text-[var(--text-secondary)] bg-[var(--bg-main)] border border-[var(--border)] hover:bg-[var(--bg-hover)] cursor-pointer"
              >
                Connect Calendar
              </button>
            </div>
          </div>
        ) : upcomingMeetings.length === 0 ? (
          <div className="text-center py-8 px-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)]">
            <Clock className="w-8 h-8 mx-auto text-[var(--sky)] mb-2" />
            <h3 className="text-sm font-bold text-[var(--text-primary)]">
              All meetings for {isToday ? 'today' : writtenDate} have passed
            </h3>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Use the dropdown above to review earlier meetings, or schedule a new one.
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
              {!showPassedDropdown && passedMeetings.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowPassedDropdown(true)}
                  className="px-4 py-2.5 rounded-xl text-sm font-semibold text-[var(--text-secondary)] bg-[var(--bg-main)] border border-[var(--border)] hover:bg-[var(--bg-hover)] cursor-pointer"
                >
                  View Passed ({passedMeetings.length})
                </button>
              )}
              <button
                type="button"
                onClick={onAddMeeting}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-extrabold bg-[var(--sky-strong)] text-white hover:bg-[var(--sky-hover)] shadow-md transition-all cursor-pointer active:scale-95"
              >
                <Plus className="w-4 h-4 stroke-[2.5]" />
                <span>Add Meeting</span>
              </button>
            </div>
          </div>
        ) : timelineLayout ? (
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] shadow-2xs overflow-hidden">
            <div className="flex relative" style={{ height: `${timelineLayout.totalHeight + 24}px` }}>
              {/* Left Hour Axis */}
              <div className="w-[46px] sm:w-16 shrink-0 border-r border-[var(--border)] bg-[var(--bg-card)] relative select-none">
                {timelineLayout.hours.map((hour) => {
                  const topPx = timelineLayout.getTopPxForMin(hour * 60);
                  return (
                    <div
                      key={hour}
                      className="absolute right-1 sm:right-2 -translate-y-1/2 text-[13px] sm:text-[11px] tracking-tight sm:tracking-normal font-bold text-[var(--text-muted)] tabular-nums whitespace-nowrap"
                      style={{ top: `${topPx}px` }}
                    >
                      {formatHourAxis(hour)}
                    </div>
                  );
                })}

                {/* Current time pill on axis */}
                {showNowLine && (
                  <div
                    className="absolute right-1 -translate-y-1/2 px-1 sm:px-1.5 py-0.5 rounded bg-[var(--sky-strong)] text-white text-[13px] sm:text-[10px] font-extrabold tabular-nums shadow-xs z-20"
                    style={{
                      top: `${timelineLayout.getTopPxForMin(currentMinutes)}px`,
                    }}
                  >
                    {currentTimeLabel.replace(/\s?(AM|PM)/, '')}
                  </div>
                )}
              </div>

              {/* Right Schedule Canvas */}
              <div ref={canvasRef} className="flex-1 relative bg-[var(--bg-card)]">
                {/* Hourly & Half-Hour Grid Lines */}
                {timelineLayout.hours.map((hour, idx) => {
                  const topPx = timelineLayout.getTopPxForMin(hour * 60);
                  const halfHourTopPx = timelineLayout.getTopPxForMin(hour * 60 + 30);
                  const isLast = idx === timelineLayout.hours.length - 1;
                  return (
                    <React.Fragment key={hour}>
                      <div
                        className="absolute left-0 right-0 border-t border-[var(--border)]"
                        style={{ top: `${topPx}px` }}
                      />
                      {!isLast && (
                        <div
                          className="absolute left-0 right-0 border-t border-dashed border-[var(--border)]"
                          style={{ top: `${halfHourTopPx}px` }}
                        />
                      )}
                    </React.Fragment>
                  );
                })}

                {/* Walk Row from Office to First In-Person Meeting of the Day */}
                {timelineLayout.hasOfficeFirstInUpcoming &&
                  officeFirstWalk &&
                  (() => {
                    const rowSpanMin = Math.max(
                      isPhoneViewport ? 22 : 16,
                      officeFirstWalk.walkMinutes + officeFirstWalk.bufferMinutes
                    );
                    const topMin = officeFirstWalk.startMin - rowSpanMin;
                    const topPx = timelineLayout.getTopPxForMin(topMin);
                    const bottomPx = timelineLayout.getTopPxForMin(officeFirstWalk.startMin);
                    const heightPx = Math.max(isPhoneViewport ? 44 : 26, bottomPx - topPx - 4);
                    return (
                      <div
                        className="absolute left-2.5 right-2.5 rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] px-2.5 sm:px-3 flex items-center justify-between gap-2 z-10 text-[13px] sm:text-xs"
                        style={{ top: `${topPx}px`, height: `${heightPx}px` }}
                      >
                        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                          <Footprints className="w-4 h-4 sm:w-3.5 sm:h-3.5 shrink-0 text-[var(--sky)]" />
                          {isPhoneViewport ? (
                            <div className="min-w-0 leading-tight">
                              <div className="font-bold truncate">
                                {officeFirstWalk.fromBuildingCode} → {officeFirstWalk.toBuildingCode} · {officeFirstWalk.walkMinutes}m
                              </div>
                              <div className="text-[13px] text-[var(--text-secondary)] font-semibold truncate">
                                leave by {officeFirstWalk.leaveBy12h}
                              </div>
                            </div>
                          ) : (
                            <span className="font-bold truncate">{officeFirstWalk.label}</span>
                          )}
                        </div>
                        <a
                          href={getGoogleMapsDirectionsUrl(
                            officeFirstWalk.fromBuildingCode,
                            officeFirstWalk.toBuildingCode,
                            'walking'
                          )}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label="Route"
                          className="inline-flex items-center justify-center gap-1 min-w-[40px] min-h-[40px] sm:min-w-0 sm:min-h-0 px-2 sm:px-2.5 py-1 rounded-lg bg-[var(--bg-main)] border border-[var(--border)] text-[var(--sky-strong)] hover:bg-[var(--sky-strong)] hover:text-white text-[13px] sm:text-[11px] font-bold shadow-2xs transition-colors shrink-0"
                          title="Open walking directions from office in Google Maps"
                        >
                          <Navigation className="w-4 h-4 sm:w-3 sm:h-3" />
                          <span className="hidden sm:inline">Route</span>
                          <ExternalLink className="hidden sm:inline w-2.5 h-2.5 opacity-75" />
                        </a>
                      </div>
                    );
                  })()}

                {/* Travel / Walk Gap Blocks */}
                {timelineLayout.gapLegs.map(
                  ({
                    leg,
                    topMin,
                    gapMin,
                    isOfficeTrip,
                    minVisualHeightPx,
                    showWalkToOffice = true,
                    showAtOffice = true,
                    showWalkFromOffice = true,
                    atOfficeStartTime12h,
                  }) => {
                    const slotTopPx = timelineLayout.getTopPxForMin(topMin, false);
                    const slotBottomPx = timelineLayout.getTopPxForMin(topMin + gapMin, true);
                    const slotSpanPx = Math.max(isPhoneViewport ? 44 : 28, slotBottomPx - slotTopPx);

                    const nxtDep = departureByMeetingId[leg.toMeeting.id];
                    if (isOfficeTrip && nxtDep && settings.office?.buildingCode) {
                      const officeCode = settings.office.buildingCode;
                      const topPx = slotTopPx + 1;
                      const heightPx = Math.max(minVisualHeightPx - 4, slotSpanPx - 4);
                      const startLabel = atOfficeStartTime12h || nxtDep.officeArrivalTime12h;
                      return (
                        <div
                          key={leg.id}
                          className="absolute left-2.5 right-2.5 flex flex-col justify-between gap-1 z-10"
                          style={{ top: `${topPx}px`, height: `${heightPx}px` }}
                        >
                          {/* 1. Walk to Office (hidden once already at office) */}
                          {showWalkToOffice && (
                            <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] px-2.5 py-1 flex items-center justify-between gap-2 text-[13px] sm:text-[11px] shrink-0">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <Footprints className="w-4 h-4 sm:w-3.5 sm:h-3.5 shrink-0 text-[var(--sky)]" />
                                <span className="font-bold truncate">
                                  {isPhoneViewport
                                    ? `${leg.fromMeeting.buildingCode} → ${officeCode} · ${nxtDep.toOfficeWalkMinutes}m`
                                    : `${leg.fromMeeting.buildingCode} → Office ${officeCode} · ${nxtDep.toOfficeWalkMinutes}m walk`}
                                </span>
                              </div>
                              <a
                                href={getGoogleMapsDirectionsUrl(
                                  leg.fromMeeting.buildingCode,
                                  officeCode,
                                  'walking'
                                )}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-label="Route"
                                className="inline-flex items-center justify-center gap-1 min-w-[40px] min-h-[40px] sm:min-w-0 sm:min-h-0 px-2 py-0.5 rounded-md bg-[var(--bg-main)] border border-[var(--border)] text-[var(--sky-strong)] hover:bg-[var(--sky-strong)] hover:text-white text-[13px] sm:text-[10px] font-bold shadow-2xs transition-colors shrink-0"
                                title="Open walking directions to office in Google Maps"
                              >
                                <Navigation className="w-4 h-4 sm:w-2.5 sm:h-2.5" />
                                <span className="hidden sm:inline">Route</span>
                                <ExternalLink className="hidden sm:inline w-2 h-2 opacity-75" />
                              </a>
                            </div>
                          )}

                          {/* 2. At Your Office Block (--bg-hover) */}
                          {showAtOffice && (
                            <div className="flex-1 min-h-[24px] rounded-lg border border-[var(--border)] bg-[var(--bg-hover)] text-[var(--text-primary)] px-2.5 py-1 flex items-center justify-between gap-2 text-[13px] sm:text-[11px]">
                              <span className="font-bold truncate">
                                🏢 At your office · {startLabel} – {nxtDep.leaveByTime12h}
                              </span>
                            </div>
                          )}

                          {/* 3. Walk from Office to Next Meeting */}
                          {showWalkFromOffice && (
                            <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] px-2.5 py-1 flex items-center justify-between gap-2 text-[13px] sm:text-[11px] shrink-0">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <Footprints className="w-4 h-4 sm:w-3.5 sm:h-3.5 shrink-0 text-[var(--sky)]" />
                                {isPhoneViewport ? (
                                  <div className="min-w-0 leading-tight">
                                    <div className="font-bold truncate">
                                      {officeCode} → {leg.toMeeting.buildingCode} · {nxtDep.walkMinutes}m
                                    </div>
                                    <div className="text-[13px] text-[var(--text-secondary)] font-semibold truncate">
                                      leave by {nxtDep.leaveByTime12h}
                                    </div>
                                  </div>
                                ) : (
                                  <span className="font-bold truncate">
                                    Office {officeCode} → {leg.toMeeting.buildingCode} · {nxtDep.walkMinutes}m walk · leave by {nxtDep.leaveByTime12h}
                                  </span>
                                )}
                              </div>
                              <a
                                href={getGoogleMapsDirectionsUrl(
                                  officeCode,
                                  leg.toMeeting.buildingCode,
                                  'walking'
                                )}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-label="Route"
                                className="inline-flex items-center justify-center gap-1 min-w-[40px] min-h-[40px] sm:min-w-0 sm:min-h-0 px-2 py-0.5 rounded-md bg-[var(--bg-main)] border border-[var(--border)] text-[var(--sky-strong)] hover:bg-[var(--sky-strong)] hover:text-white text-[13px] sm:text-[10px] font-bold shadow-2xs transition-colors shrink-0"
                                title="Open walking directions from office in Google Maps"
                              >
                                <Navigation className="w-4 h-4 sm:w-2.5 sm:h-2.5" />
                                <span className="hidden sm:inline">Route</span>
                                <ExternalLink className="hidden sm:inline w-2 h-2 opacity-75" />
                              </a>
                            </div>
                          )}
                        </div>
                      );
                    }

                    const isCompactGap = gapMin < 18;
                    const topPx = slotTopPx + (isCompactGap ? 1 : 2);
                    const heightPx = Math.max(
                      isPhoneViewport ? 44 : isCompactGap ? 26 : 30,
                      slotSpanPx - 4
                    );
                    const isStillAhead =
                      !isToday || parseTimeToMinutes(leg.toMeeting.startTime) > currentMinutes;
                    const isLate =
                      isStillAhead && (leg.status === 'IMPOSSIBLE' || leg.status === 'LATE');
                    const isTight = isStillAhead && leg.status === 'TIGHT';
                    const isResolved =
                      !isLate &&
                      !isTight &&
                      (Boolean(resolvedByMeetingId[leg.toMeeting.id]) ||
                        Boolean(resolvedByMeetingId[leg.fromMeeting.id]));
                    const isShortLateGap = isLate && gapMin >= 0 && gapMin < 5;

                    if (isPhoneViewport) {
                      return (
                        <div
                          key={leg.id}
                          className={`absolute left-2.5 right-2.5 rounded-lg border px-2.5 flex items-center justify-between gap-2 z-10 text-[13px] leading-tight ${
                            isShortLateGap
                              ? 'border-[var(--status-late-fg)]/40 bg-[var(--status-late-bg)] text-[var(--status-late-fg)]'
                              : 'border-dashed border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)]'
                          }`}
                          style={{ top: `${topPx}px`, height: `${heightPx}px` }}
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            {isResolved ? (
                              <CheckCircle2 className="w-4 h-4 shrink-0 text-[var(--status-ok-fg)]" />
                            ) : (
                              <Footprints
                                className={`w-4 h-4 shrink-0 ${
                                  isLate
                                    ? 'text-[var(--status-late-fg)]'
                                    : isTight
                                    ? 'text-[var(--status-tight-fg)]'
                                    : 'text-[var(--sky)]'
                                }`}
                              />
                            )}
                            <span className="font-bold truncate">
                              {leg.fromMeeting.buildingCode} → {leg.toMeeting.buildingCode} ·{' '}
                              {leg.questFlowTravelMinutes}m
                            </span>
                            {isLate && (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--status-late-bg)] text-[var(--status-late-fg)] text-[13px] font-extrabold shrink-0">
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                <span>Late</span>
                              </span>
                            )}
                            {isTight && (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--status-tight-bg)] text-[var(--status-tight-fg)] text-[13px] font-extrabold shrink-0">
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                <span>Tight</span>
                              </span>
                            )}
                            {isResolved && (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--status-ok-bg)] text-[var(--status-ok-fg)] text-[13px] font-extrabold shrink-0">
                                <Check className="w-3.5 h-3.5 shrink-0" />
                                <span>Fixed</span>
                              </span>
                            )}
                          </div>
                          <a
                            href={getGoogleMapsDirectionsUrl(
                              leg.fromMeeting.buildingCode,
                              leg.toMeeting.buildingCode,
                              'walking'
                            )}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="Route"
                            className={`inline-flex items-center justify-center min-w-[40px] min-h-[40px] px-2 rounded-lg border text-[13px] font-bold shadow-2xs transition-colors shrink-0 ${
                              isShortLateGap
                                ? 'bg-[var(--bg-card)] border-[var(--status-late-fg)]/30 text-[var(--status-late-fg)] hover:bg-[var(--status-late-fg)] hover:text-white'
                                : 'bg-[var(--bg-main)] border-[var(--border)] text-[var(--sky-strong)] hover:bg-[var(--sky-strong)] hover:text-white'
                            }`}
                            title="Open walking directions in Google Maps"
                          >
                            <Navigation className="w-4 h-4" />
                          </a>
                        </div>
                      );
                    }

                    if (isShortLateGap) {
                      return (
                        <div
                          key={leg.id}
                          className="absolute left-2.5 right-2.5 rounded-lg border border-[var(--status-late-fg)]/40 bg-[var(--status-late-bg)] text-[var(--status-late-fg)] px-2.5 flex items-center justify-between gap-2 z-10 text-[11px] leading-none"
                          style={{ top: `${topPx}px`, height: `${heightPx}px` }}
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <Footprints className="w-3.5 h-3.5 shrink-0 text-[var(--status-late-fg)]" />
                            <span className="font-bold truncate">
                              {leg.fromMeeting.buildingCode} → {leg.toMeeting.buildingCode} ·{' '}
                              {leg.questFlowTravelMinutes}m walk · you have {leg.gapMinutes}
                            </span>
                          </div>
                          <a
                            href={getGoogleMapsDirectionsUrl(
                              leg.fromMeeting.buildingCode,
                              leg.toMeeting.buildingCode,
                              'walking'
                            )}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--bg-card)] border border-[var(--status-late-fg)]/30 text-[var(--status-late-fg)] hover:bg-[var(--status-late-fg)] hover:text-white text-[10px] font-bold shadow-2xs transition-colors shrink-0"
                            title="Open walking directions in Google Maps"
                          >
                            <Navigation className="w-2.5 h-2.5" />
                            <span>Route</span>
                            <ExternalLink className="w-2 h-2 opacity-75" />
                          </a>
                        </div>
                      );
                    }

                  if (isCompactGap) {
                    return (
                      <div
                        key={leg.id}
                        className="absolute left-2.5 right-2.5 rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] px-2.5 flex items-center justify-between gap-2 z-10 text-[11px] leading-none"
                        style={{ top: `${topPx}px`, height: `${heightPx}px` }}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          {isResolved ? (
                            <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-[var(--status-ok-fg)]" />
                          ) : (
                            <Footprints
                              className={`w-3.5 h-3.5 shrink-0 ${
                                isLate
                                  ? 'text-[var(--status-late-fg)]'
                                  : isTight
                                  ? 'text-[var(--status-tight-fg)]'
                                  : 'text-[var(--sky)]'
                              }`}
                            />
                          )}
                          <span className="font-bold truncate">
                            {leg.fromMeeting.buildingCode} → {leg.toMeeting.buildingCode} ·{' '}
                            {leg.questFlowTravelMinutes}m walk
                          </span>
                          {isLate && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--status-late-bg)] text-[var(--status-late-fg)] text-[10px] font-extrabold uppercase shrink-0">
                              <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
                              <span>Late</span>
                            </span>
                          )}
                          {isTight && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--status-tight-bg)] text-[var(--status-tight-fg)] text-[10px] font-extrabold uppercase shrink-0">
                              <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
                              <span>Tight</span>
                            </span>
                          )}
                          {isResolved && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--status-ok-bg)] text-[var(--status-ok-fg)] text-[10px] font-extrabold uppercase shrink-0">
                              <Check className="w-2.5 h-2.5 shrink-0" />
                              <span>Fixed</span>
                            </span>
                          )}
                        </div>
                        <a
                          href={getGoogleMapsDirectionsUrl(
                            leg.fromMeeting.buildingCode,
                            leg.toMeeting.buildingCode,
                            'walking'
                          )}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--bg-main)] border border-[var(--border)] text-[var(--sky-strong)] hover:bg-[var(--sky-strong)] hover:text-white text-[10px] font-bold shadow-2xs transition-colors shrink-0"
                          title="Open walking directions in Google Maps"
                        >
                          <Navigation className="w-2.5 h-2.5" />
                          <span>Route</span>
                          <ExternalLink className="w-2 h-2 opacity-75" />
                        </a>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={leg.id}
                      className="absolute left-2.5 right-2.5 rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] px-3 flex flex-col justify-center gap-1 z-10"
                      style={{ top: `${topPx}px`, height: `${heightPx}px` }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0 text-xs">
                          {isResolved ? (
                            <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-[var(--status-ok-fg)]" />
                          ) : (
                            <Footprints
                              className={`w-3.5 h-3.5 shrink-0 ${
                                isLate
                                  ? 'text-[var(--status-late-fg)]'
                                  : isTight
                                  ? 'text-[var(--status-tight-fg)]'
                                  : 'text-[var(--sky)]'
                              }`}
                            />
                          )}
                          <span className="font-bold truncate">
                            {leg.fromMeeting.buildingCode} → {leg.toMeeting.buildingCode} ·{' '}
                            {leg.questFlowTravelMinutes}m walk
                          </span>
                          {isLate && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--status-late-bg)] text-[var(--status-late-fg)] text-[10px] font-extrabold uppercase shrink-0">
                              <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
                              <span>Late</span>
                            </span>
                          )}
                          {isTight && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--status-tight-bg)] text-[var(--status-tight-fg)] text-[10px] font-extrabold uppercase shrink-0">
                              <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
                              <span>Tight</span>
                            </span>
                          )}
                          {isResolved && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--status-ok-bg)] text-[var(--status-ok-fg)] text-[10px] font-extrabold uppercase shrink-0">
                              <Check className="w-2.5 h-2.5 shrink-0" />
                              <span>Fixed</span>
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <a
                            href={getGoogleMapsDirectionsUrl(
                              leg.fromMeeting.buildingCode,
                              leg.toMeeting.buildingCode,
                              'walking'
                            )}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--bg-main)] border border-[var(--border)] text-[var(--sky-strong)] hover:bg-[var(--sky-strong)] hover:text-white text-[11px] font-bold shadow-2xs transition-colors shrink-0"
                            title="Open walking directions in Google Maps"
                          >
                            <Navigation className="w-3 h-3" />
                            <span>Route</span>
                            <ExternalLink className="w-2.5 h-2.5 opacity-75" />
                          </a>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Positioned Meeting Time Blocks */}
                {timelineLayout.positioned.map(({ meeting, startMin, endMin, col, totalCols }) => {
                  const format = meeting.format || (meeting.isOnline ? 'online' : 'in_person');
                  const isOnline = isMeetingOnline(meeting);
                  const isLocationUnknown = isMeetingLocationUnknown(meeting);
                  const isInProgress =
                    isToday && startMin <= currentMinutes && currentMinutes < endMin;
                  const minsLeft = isInProgress ? endMin - currentMinutes : 0;
                  const targetProblem = problemByTargetId[meeting.id];
                  const isTightProblem = targetProblem?.leg.status === 'TIGHT';
                  const isInlineResolved =
                    !targetProblem && Boolean(resolvedByMeetingId[meeting.id]);
                  const hasLine3 = Boolean(isInProgress || targetProblem || isInlineResolved);

                  const durationMin = endMin - startMin;
                  const topPx = timelineLayout.getTopPxForMin(startMin, true);
                  const bottomPx = timelineLayout.getTopPxForMin(endMin, false);
                  const minCardHeightPx = isPhoneViewport
                    ? hasLine3
                      ? 112
                      : 72
                    : 52;
                  const heightPx = Math.max(minCardHeightPx, bottomPx - topPx - 2);
                  const isCompact = heightPx < 76;

                  const mapsUrl =
                    !isOnline && !isLocationUnknown
                      ? getGoogleMapsBuildingUrl(meeting.buildingCode)
                      : '';

                  const widthPct = 100 / totalCols;
                  const leftPct = col * widthPct;
                  const cardWidthPx = canvasWidth / totalCols - 16;
                  const isNarrowCard = isPhoneViewport || totalCols > 1 || cardWidthPx < 320;
                  const isMenuOpen = openMenuMeetingId === meeting.id;

                  const locCompact = isOnline
                    ? 'Teams'
                    : isLocationUnknown
                    ? 'Set location'
                    : `${meeting.buildingCode}${meeting.roomNumber ? ` ${meeting.roomNumber}` : ''}`;
                  const phoneTimeAndPlace = `${formatTimeRangePhone(
                    meeting.startTime,
                    meeting.endTime
                  )} · ${locCompact}`;

                  return (
                    <div
                      key={meeting.id}
                      id={`meeting-block-${meeting.id}`}
                      onClick={() => onEditMeeting(meeting)}
                      className={`absolute rounded-xl border shadow-xs transition-all cursor-pointer flex flex-col justify-between ${
                        isMenuOpen ? 'overflow-visible z-30' : 'overflow-hidden z-10'
                      } ${
                        isInProgress
                          ? 'ring-2 ring-[var(--sky-strong)]/40 border-[var(--sky-strong)]'
                          : 'hover:shadow-md'
                      } ${
                        format === 'online'
                          ? 'bg-[var(--bg-card)] border-[var(--border)] border-l-4 border-l-[var(--oatmeal)] text-[var(--text-primary)]'
                          : 'bg-[var(--sky-tint)] border-[var(--border)] border-l-4 border-l-[var(--sky)] text-[var(--sky-strong)]'
                      }`}
                      style={{
                        top: `${topPx}px`,
                        height: `${heightPx}px`,
                        left: `calc(${leftPct}% + 8px)`,
                        width: `calc(${widthPct}% - 16px)`,
                      }}
                    >
                      {isNarrowCard ? (
                        /* PHONE (< 640px) & NARROW CARD:
                           Line 1: title (up to 2 lines, then "…")
                           Line 2: time and place, e.g. "1:45–2:30 PM · NH 3001" (one line, truncate with "…")
                           Line 3 (only if there is one): status badge and "Fix this"
                           Top-right "⋯" menu for Maps, Campus/Teams, Edit, Delete */
                        <div className="px-2.5 py-2 flex items-start justify-between gap-1.5 h-full relative">
                          <div className="min-w-0 flex-1 flex flex-col justify-between h-full">
                            <div className="min-w-0">
                              <h3
                                className={`text-[13px] sm:text-xs font-extrabold line-clamp-2 leading-tight ${
                                  format === 'online'
                                    ? 'text-[var(--text-primary)]'
                                    : 'text-[var(--sky-strong)]'
                                }`}
                              >
                                {meeting.title}
                              </h3>
                              <p
                                className={`text-[13px] sm:text-[11px] font-semibold truncate mt-0.5 tabular-nums ${
                                  format === 'online'
                                    ? 'text-[var(--text-secondary)]'
                                    : 'text-[var(--sky-strong)]'
                                }`}
                              >
                                {phoneTimeAndPlace}
                              </p>
                            </div>

                            {hasLine3 && (
                              <div className="flex items-center gap-1.5 flex-nowrap mt-1 min-w-0">
                                {isInProgress && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--sky-strong)] text-white text-[13px] sm:text-[10px] font-extrabold shrink-0">
                                    <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                                    <span>{minsLeft}m left</span>
                                  </span>
                                )}
                                {targetProblem && (
                                  <span
                                    id={`transition-problem-${meeting.id}`}
                                    className="inline-flex items-center gap-1.5 min-w-0"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <span
                                      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[13px] sm:text-[10px] font-extrabold truncate ${
                                        isTightProblem
                                          ? 'bg-[var(--status-tight-bg)] text-[var(--status-tight-fg)]'
                                          : 'bg-[var(--status-late-bg)] text-[var(--status-late-fg)]'
                                      }`}
                                      title={targetProblem.badgeText}
                                    >
                                      <AlertTriangle className="w-3.5 h-3.5 sm:w-2.5 sm:h-2.5 shrink-0" />
                                      <span className="truncate">{targetProblem.badgeText}</span>
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => handleOpenFixSheet(targetProblem)}
                                      className={`inline-flex items-center justify-center min-h-[40px] sm:min-h-0 px-2.5 sm:px-2 py-1 sm:py-0.5 rounded-lg sm:rounded text-white text-[13px] sm:text-[10px] font-extrabold shadow-2xs transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sky-strong)] ${
                                        isTightProblem
                                          ? 'bg-[var(--status-tight-fg)] hover:opacity-90'
                                          : 'bg-[var(--status-late-fg)] hover:opacity-90'
                                      }`}
                                    >
                                      Fix this
                                    </button>
                                  </span>
                                )}
                                {isInlineResolved && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--status-ok-bg)] text-[var(--status-ok-fg)] text-[13px] sm:text-[10px] font-extrabold shrink-0">
                                    <Check className="w-3.5 h-3.5 sm:w-2.5 sm:h-2.5" />
                                    <span>Fixed</span>
                                  </span>
                                )}
                              </div>
                            )}
                          </div>

                          {/* Single "⋯" menu button */}
                          <div
                            className="relative shrink-0 -mt-1 -mr-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              onClick={() =>
                                setOpenMenuMeetingId(isMenuOpen ? null : meeting.id)
                              }
                              aria-label="More actions"
                              className="inline-flex items-center justify-center min-w-[40px] min-h-[40px] sm:min-w-0 sm:min-h-0 p-1.5 sm:p-1 rounded-lg bg-[var(--bg-main)] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer text-[15px] sm:text-xs font-bold leading-none"
                            >
                              ⋯
                            </button>

                            {isMenuOpen && (
                              <div className="absolute right-0 top-10 sm:top-7 w-44 sm:w-40 rounded-xl bg-[var(--bg-card)] border border-[var(--border)] shadow-xl py-1 z-40 text-[13px] sm:text-xs font-semibold">
                                {!isOnline && !isLocationUnknown && (
                                    <a
                                      href={mapsUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={() => setOpenMenuMeetingId(null)}
                                      className="flex items-center gap-2 min-h-[40px] sm:min-h-0 px-3 py-2 sm:py-1.5 text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                                    >
                                      <Navigation className="w-4 h-4 sm:w-3.5 sm:h-3.5 text-[var(--sky)]" />
                                      <span>Open in Maps</span>
                                    </a>
                                  )}
                                <button
                                  type="button"
                                  onClick={() => {
                                    onQuickToggleFormat(
                                      meeting.id,
                                      isOnline ? 'in_person' : 'online'
                                    );
                                    setOpenMenuMeetingId(null);
                                  }}
                                  className="w-full flex items-center gap-2 min-h-[40px] sm:min-h-0 px-3 py-2 sm:py-1.5 text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
                                >
                                  <Video className="w-4 h-4 sm:w-3.5 sm:h-3.5 text-[var(--sky)]" />
                                  <span>{isOnline ? 'Switch to Campus' : 'Switch to Teams'}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenMenuMeetingId(null);
                                    onEditMeeting(meeting);
                                  }}
                                  className="w-full flex items-center gap-2 min-h-[40px] sm:min-h-0 px-3 py-2 sm:py-1.5 text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
                                >
                                  <Edit3 className="w-4 h-4 sm:w-3.5 sm:h-3.5 text-[var(--text-muted)]" />
                                  <span>Edit</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenMenuMeetingId(null);
                                    onDeleteMeeting(meeting.id);
                                  }}
                                  className="w-full flex items-center gap-2 min-h-[40px] sm:min-h-0 px-3 py-2 sm:py-1.5 text-left text-[var(--status-late-fg)] hover:bg-[var(--status-late-bg)] cursor-pointer"
                                >
                                  <Trash2 className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                                  <span>Delete</span>
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        /* WIDE CARD (≥ 320px): Unchanged layout */
                        <div
                          className={`px-3 ${
                            isCompact
                              ? 'py-1.5 flex items-center justify-between gap-2 h-full'
                              : 'py-2 flex items-start justify-between gap-2'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <h3 className={`text-xs sm:text-sm font-extrabold truncate leading-tight ${format === 'online' ? 'text-[var(--text-primary)]' : 'text-[var(--sky-strong)]'}`}>
                                {meeting.title}
                              </h3>
                              {isInProgress && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--sky-strong)] text-white text-[10px] font-extrabold uppercase shrink-0">
                                  <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                                  <span>{minsLeft}m left</span>
                                </span>
                              )}
                              {targetProblem && (
                                <span
                                  id={`transition-problem-${meeting.id}`}
                                  className="inline-flex items-center gap-1 shrink-0"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <span
                                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-extrabold ${
                                      targetProblem.isOverlap ? '' : 'uppercase'
                                    } ${
                                      isTightProblem
                                        ? 'bg-[var(--status-tight-bg)] text-[var(--status-tight-fg)]'
                                        : 'bg-[var(--status-late-bg)] text-[var(--status-late-fg)]'
                                    }`}
                                  >
                                    <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
                                    <span>{targetProblem.badgeText}</span>
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => handleOpenFixSheet(targetProblem)}
                                    className={`px-2 py-0.5 rounded text-white text-[10px] font-extrabold shadow-2xs transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sky-strong)] ${
                                      isTightProblem
                                        ? 'bg-[var(--status-tight-fg)] hover:opacity-90'
                                        : 'bg-[var(--status-late-fg)] hover:opacity-90'
                                    }`}
                                  >
                                    Fix this
                                  </button>
                                </span>
                              )}
                              {isInlineResolved && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--status-ok-bg)] text-[var(--status-ok-fg)] text-[10px] font-extrabold uppercase shrink-0">
                                  <Check className="w-2.5 h-2.5" />
                                  <span>Fixed</span>
                                </span>
                              )}
                            </div>

                            <div className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-[11px] font-semibold ${format === 'online' ? 'text-[var(--text-secondary)]' : 'text-[var(--sky-strong)]'}`}>
                              {isOnline ? (
                                <span className="inline-flex items-center gap-1 text-[var(--text-secondary)]">
                                  <Video className="w-3 h-3 text-[var(--sky)] shrink-0" />
                                  <span>Teams</span>
                                </span>
                              ) : isLocationUnknown ? (
                                <span className="inline-flex items-center gap-1 text-[var(--status-tight-fg)]">
                                  <MapPin className="w-3 h-3 shrink-0" />
                                  <span>Set location</span>
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1">
                                  <MapPin className="w-3 h-3 text-[var(--sky)] shrink-0" />
                                  <span>
                                    {meeting.buildingCode}
                                    {meeting.roomNumber ? ` ${meeting.roomNumber}` : ''}
                                    {format === 'hybrid' ? ' / Teams' : ''}
                                  </span>
                                </span>
                              )}
                              <span className={format === 'online' ? 'text-[var(--text-muted)]' : 'text-[var(--sky-strong)]'}>·</span>
                              <span className={`tabular-nums ${format === 'online' ? 'text-[var(--text-muted)]' : 'text-[var(--sky-strong)]'}`}>
                                {formatDurationBadge(durationMin)} ({formatTime12h(meeting.startTime)} –{' '}
                                {formatTime12h(meeting.endTime)})
                              </span>
                            </div>
                          </div>

                          {/* Block Action Buttons (stopPropagation so clicking them doesn't trigger block edit) */}
                          <div
                            className="flex items-center gap-1 shrink-0"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {!isOnline && !isLocationUnknown && (
                                <a
                                  href={mapsUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--bg-main)] border border-[var(--border)] text-[var(--sky-strong)] hover:bg-[var(--sky-strong)] hover:text-white text-[11px] font-bold shadow-2xs transition-colors"
                                  title={`Open ${meeting.buildingCode} in Google Maps`}
                                >
                                  <Navigation className="w-3 h-3 shrink-0" />
                                  <span className="hidden sm:inline">Maps</span>
                                </a>
                              )}

                            {!isCompact && (
                              <div className="hidden sm:inline-flex rounded-lg border border-[var(--border)] p-0.5 bg-[var(--bg-main)] text-[11px] font-semibold">
                                <button
                                  type="button"
                                  onClick={() => onQuickToggleFormat(meeting.id, 'in_person')}
                                  className={`px-1.5 py-0.5 rounded transition-colors cursor-pointer ${
                                    format === 'in_person' || format === 'hybrid'
                                      ? 'bg-[var(--sky-strong)] text-white'
                                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                                  }`}
                                >
                                  Campus
                                </button>
                                <button
                                  type="button"
                                  onClick={() => onQuickToggleFormat(meeting.id, 'online')}
                                  className={`px-1.5 py-0.5 rounded transition-colors cursor-pointer ${
                                    format === 'online'
                                      ? 'bg-[var(--sky-strong)] text-white'
                                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                                  }`}
                                >
                                  Teams
                                </button>
                              </div>
                            )}

                            <button
                              type="button"
                              onClick={() => onEditMeeting(meeting)}
                              className="p-1 rounded-lg text-[var(--text-secondary)] hover:text-[var(--sky-strong)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sky-strong)]"
                              title="Edit Meeting"
                              aria-label="Edit meeting"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>

                            {deleteConfirmId === meeting.id ? (
                              <div className="flex items-center gap-0.5 bg-[var(--status-late-bg)] p-0.5 rounded-lg border border-[var(--status-late-fg)]/30">
                                <button
                                  type="button"
                                  onClick={() => {
                                    onDeleteMeeting(meeting.id);
                                    setDeleteConfirmId(null);
                                  }}
                                  className="px-1.5 py-0.5 text-[10px] font-bold text-white bg-[var(--status-late-fg)] rounded cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--status-late-fg)]"
                                  aria-label="Confirm delete meeting"
                                >
                                  Del
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDeleteConfirmId(null)}
                                  className="px-1 py-0.5 text-[10px] text-[var(--text-secondary)] rounded cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sky-strong)]"
                                  aria-label="Cancel delete"
                                >
                                  ✕
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setDeleteConfirmId(meeting.id)}
                                className="p-1 rounded-lg text-[var(--text-secondary)] hover:text-[var(--status-late-fg)] hover:bg-[var(--status-late-bg)] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--status-late-fg)]"
                                title="Delete Meeting"
                                aria-label="Delete meeting"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Live Current-Time Horizontal Needle */}
                {showNowLine && (
                  <div
                    className="absolute left-0 right-0 z-20 pointer-events-none flex items-center"
                    style={{
                      top: `${timelineLayout.getTopPxForMin(currentMinutes)}px`,
                    }}
                  >
                    <div className="w-2.5 h-2.5 rounded-full bg-[var(--sky-strong)] -ml-1.5 ring-2 ring-[var(--bg-main)]" />
                    <div className="flex-1 h-0.5 bg-[var(--sky-strong)]" />
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Footer Suggestion & Navigation: Sync Calendar or Next Meeting */}
      <div className="pt-4 border-t border-[var(--border)]">
        <div className="p-4 sm:p-5 rounded-2xl bg-[var(--bg-card)] border border-[var(--border)] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-[var(--text-primary)]">
              Sync your own calendar
            </p>
            <p className="text-xs text-[var(--text-secondary)]">
              Import your Outlook or .ICS schedule, or jump straight to your next meeting with Google Maps directions.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={onBackToConnect}
              className="px-4 py-2.5 text-xs sm:text-sm font-bold text-[var(--sky-strong)] bg-[var(--bg-main)] hover:bg-[var(--bg-hover)] border border-[var(--border)] rounded-xl transition-colors flex items-center justify-center gap-2 cursor-pointer shadow-2xs"
            >
              <Link2 className="w-4 h-4 shrink-0" />
              <span>Sync My Calendar</span>
            </button>

            <button
              type="button"
              onClick={onOpenNextMeeting}
              className="px-5 py-2.5 text-xs sm:text-sm font-bold text-white bg-[var(--sky-strong)] hover:bg-[var(--sky-hover)] rounded-xl shadow-sm transition-colors flex items-center justify-center gap-2 active:scale-[0.98] cursor-pointer"
            >
              <span>Next Meeting</span>
              <ArrowRight className="w-4 h-4 shrink-0" />
            </button>
          </div>
        </div>
      </div>

      {/* Fix Transition Sheet (Bottom sheet on phone, centered dialog on desktop) */}
      {activeFixProblem && (() => {
        const { earlier, later, leg, isOverlap, targetMeeting, otherMeeting } = activeFixProblem;
        const fromLoc =
          formatBuildingRoomLabel(earlier.buildingCode, earlier.roomNumber) || earlier.title;
        const toLoc =
          formatBuildingRoomLabel(later.buildingCode, later.roomNumber) || later.title;
        const targetLoc =
          formatBuildingRoomLabel(targetMeeting.buildingCode, targetMeeting.roomNumber) ||
          targetMeeting.title;
        const otherLoc =
          formatBuildingRoomLabel(otherMeeting.buildingCode, otherMeeting.roomNumber) ||
          otherMeeting.title;

        const targetIsUser =
          targetMeeting.source === 'created' || targetMeeting.source === 'new';
        const hasTargetStarted =
          isPastDate || (isToday && parseTimeToMinutes(targetMeeting.startTime) <= currentMinutes);
        const canDirectMove = targetIsUser && !hasTargetStarted;

        const targetStartMin = parseTimeToMinutes(targetMeeting.startTime);
        const targetEndMin = parseTimeToMinutes(targetMeeting.endTime);
        const targetDuration = Math.max(15, targetEndMin - targetStartMin);

        // Compute up to 3 valid slots using findAvailableSlots from src/utils/slotFinder.ts
        const otherEvents = dayMeetings.filter((m) => m.id !== targetMeeting.id);
        const slotTarget = {
          buildingCode: targetMeeting.buildingCode,
          floor: targetMeeting.floor || 1,
          isOnline: false,
          durationMinutes: targetDuration,
        };

        const departAfterMin = parseTimeToMinutes(later.startTime) - leg.gapMinutes;
        const baseMinNeeded = isOverlap
          ? parseTimeToMinutes(otherMeeting.endTime)
          : departAfterMin +
            leg.questFlowTravelMinutes +
            (settings.arrivalBufferMinutes ?? 5);
        const preferredQuarter = formatMinutesToTime(Math.ceil(baseMinNeeded / 15) * 15);
        const preferredFive = formatMinutesToTime(Math.ceil(baseMinNeeded / 5) * 5);

        const afterConflictSlots = findAvailableSlots(
          otherEvents,
          slotTarget,
          settings,
          '08:00',
          '18:00',
          preferredFive,
          selectedDate
        );
        const distinctSlots: SuggestedSlot[] =
          afterConflictSlots.length >= 3
            ? afterConflictSlots
            : findAvailableSlots(
                otherEvents,
                slotTarget,
                settings,
                '08:00',
                '18:00',
                undefined,
                selectedDate
              );

        const earliestStart = distinctSlots[0]?.startTime || preferredQuarter;
        const earliestStart12h = formatTime12h(earliestStart);

        // Leave earlier meeting by time (for non-overlapping walking transitions)
        const laterStartMin = parseTimeToMinutes(later.startTime);
        const leaveEarlierBy = formatMinutesToTime(
          laterStartMin -
            (leg.status === 'TIGHT'
              ? leg.questFlowTravelMinutes + leg.bufferMinutes
              : leg.questFlowTravelMinutes)
        );
        const leaveEarlierBy12h = formatTime12h(leaveEarlierBy);

        const sheetTitle = isOverlap
          ? `${targetIsUser ? `Your meeting (${targetMeeting.title})` : targetMeeting.title} in ${targetLoc} overlaps ${otherMeeting.title} in ${otherLoc}`
          : `${fromLoc} → ${toLoc} needs ${leg.questFlowTravelMinutes} min. You have ${leg.gapMinutes}.`;

        const triggerDraft = async (type: 'later_start' | 'join_online') => {
          setFixDraftType(type);
          setIsDraftingFix(true);
          setFixCopied(false);

          const organizer = later.organizer || targetMeeting.organizer || 'there';
          const fallbackText =
            type === 'join_online'
              ? `Hi ${organizer},\n\nI have a back-to-back schedule across campus right around our session (${fromLoc} and ${toLoc}) and won't have enough travel time to make it in person.\n\nWould it be alright if I joined via Teams / virtually so we can start promptly? Let me know if that works!`
              : `Hi ${organizer},\n\nLooking forward to our meeting today. I have a prior commitment in ${fromLoc} ending at ${formatTime12h(earlier.endTime)}, and realistic room-to-room walking across campus takes ~${leg.questFlowTravelMinutes} minutes.\n\nCould we start a few minutes later at ${earliestStart12h} so I can get there without cutting into our discussion? Thank you!`;

          setFixDraftText(fallbackText);

          try {
            const minutesShift = Math.max(
              10,
              parseTimeToMinutes(earliestStart) - parseTimeToMinutes(later.startTime)
            );
            const res = await fetch('/api/gemini/draft-message', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type,
                fromMeeting: earlier,
                toMeeting: later,
                gapMinutes: leg.gapMinutes,
                travelMinutes: leg.questFlowTravelMinutes,
                minutesLate: minutesShift,
              }),
            });
            if (res.ok) {
              const data = await res.json();
              if (data.message) setFixDraftText(data.message);
            }
          } catch {
            // Keep deterministic fallback text
          } finally {
            setIsDraftingFix(false);
          }
        };

        const handleCopyDraft = async () => {
          if (!fixDraftText) return;
          try {
            await navigator.clipboard.writeText(fixDraftText);
          } catch {}
          setFixCopied(true);
          setTimeout(() => setFixCopied(false), 2500);
        };

        return (
          <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-[var(--text-primary)]/45 backdrop-blur-xs animate-in fade-in duration-150"
            onClick={() => setActiveFixProblem(null)}
            role="dialog"
            aria-modal="true"
          >
            <div
              ref={fixSheetRef}
              className="relative w-full sm:max-w-md bg-[var(--bg-card)] rounded-t-3xl sm:rounded-2xl border-t sm:border border-[var(--border)] shadow-2xl overflow-hidden z-10 flex flex-col max-h-[90vh]"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Mobile pull handle */}
              <div className="pt-2.5 pb-1 flex justify-center sm:hidden">
                <div className="w-10 h-1 rounded-full bg-[var(--oatmeal)]" />
              </div>

              {/* Sheet Header */}
              <div className="px-5 py-4 border-b border-[var(--border)] flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-extrabold text-[var(--text-primary)] leading-snug">
                    {sheetTitle}
                  </h2>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5">
                    {earlier.title} ({formatTime12h(earlier.startTime)}–{formatTime12h(earlier.endTime)}) ·{' '}
                    {later.title} ({formatTime12h(later.startTime)}–{formatTime12h(later.endTime)})
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveFixProblem(null)}
                  className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Options Body */}
              <div className="p-5 overflow-y-auto space-y-3">
                {/* 1. Primary Option: Move user-created meeting (if not already started) OR Ask to start at... */}
                {canDirectMove ? (
                  distinctSlots.length > 0 ? (
                    <div className="p-3.5 rounded-xl bg-[var(--sky-tint)] border border-[var(--sky)] space-y-2.5">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-[var(--sky-strong)]">
                        <Clock className="w-3.5 h-3.5 text-[var(--sky)] shrink-0" />
                        <span>Move {targetMeeting.title} to:</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {distinctSlots.map((slot) => (
                          <button
                            key={slot.startTime}
                            type="button"
                            onClick={() => {
                              onSaveMeeting?.({
                                ...targetMeeting,
                                startTime: slot.startTime,
                                endTime: slot.endTime,
                              });
                              applyResolvedConfirmation(
                                targetMeeting.id,
                                `Moved "${targetMeeting.title}" to ${formatTime12h(slot.startTime)}–${formatTime12h(slot.endTime)}`
                              );
                            }}
                            className="px-3.5 py-2 rounded-lg bg-[var(--sky-strong)] hover:bg-[var(--sky-hover)] text-white text-xs font-extrabold font-mono shadow-xs transition-all cursor-pointer active:scale-95"
                          >
                            {formatTime12h(slot.startTime)}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : isToday ? (
                    <div className="p-3.5 rounded-xl bg-[var(--bg-main)] border border-[var(--border)] text-xs font-semibold text-[var(--text-secondary)]">
                      No times left today
                    </div>
                  ) : null
                ) : !targetIsUser ? (
                  <button
                    type="button"
                    onClick={() => triggerDraft('later_start')}
                    className="w-full px-4 py-3 rounded-xl bg-[var(--sky-strong)] hover:bg-[var(--sky-hover)] text-white text-xs sm:text-sm font-bold shadow-xs transition-all flex items-center justify-center gap-2 cursor-pointer active:scale-[0.98]"
                  >
                    <MessageSquare className="w-4 h-4 shrink-0" />
                    <span>Ask to start at {earliestStart12h}</span>
                  </button>
                ) : null}

                {/* 2. Secondary Options: Join online instead & Ask the organizer */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => triggerDraft('join_online')}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--bg-main)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] border border-[var(--border)] text-xs font-semibold transition-all flex items-center justify-center gap-1.5 cursor-pointer active:scale-[0.98]"
                  >
                    <Video className="w-3.5 h-3.5 text-[var(--sky)] shrink-0" />
                    <span>Join online instead</span>
                  </button>

                  {targetIsUser && (
                    <button
                      type="button"
                      onClick={() => triggerDraft('later_start')}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--bg-main)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] border border-[var(--border)] text-xs font-semibold transition-all flex items-center justify-center gap-1.5 cursor-pointer active:scale-[0.98]"
                    >
                      <MessageSquare className="w-3.5 h-3.5 text-[var(--sky)] shrink-0" />
                      <span>Ask the organizer</span>
                    </button>
                  )}
                </div>

                {/* Draft Box when "Ask to start at..." / "Ask the organizer" or "Join online instead" is clicked */}
                {fixDraftType && (
                  <div className="p-3.5 rounded-xl bg-[var(--bg-main)] border border-[var(--border)] space-y-2.5 animate-in fade-in duration-150">
                    <div className="flex items-center justify-between text-xs font-semibold text-[var(--text-secondary)]">
                      <span>
                        {fixDraftType === 'later_start'
                          ? `Note proposing ${earliestStart12h} start`
                          : 'Note to join online'}
                      </span>
                      {isDraftingFix && (
                        <span className="inline-flex items-center gap-1 text-[var(--sky-strong)]">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>Drafting...</span>
                        </span>
                      )}
                    </div>

                    <textarea
                      rows={4}
                      value={fixDraftText}
                      onChange={(e) => setFixDraftText(e.target.value)}
                      className="w-full p-2.5 text-xs rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--sky-strong)]"
                    />

                    <div className="flex flex-col sm:flex-row gap-2">
                      <button
                        type="button"
                        onClick={handleCopyDraft}
                        className="flex-1 px-3 py-2 rounded-lg bg-[var(--sky-strong)] hover:bg-[var(--sky-hover)] text-white text-xs font-bold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                      >
                        {fixCopied ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-white" />
                            <span>Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>Copy</span>
                          </>
                        )}
                      </button>

                      {fixDraftType === 'join_online' && (
                        <button
                          type="button"
                          onClick={() => {
                            onQuickToggleFormat(targetMeeting.id, 'online');
                            applyResolvedConfirmation(
                              targetMeeting.id,
                              `Switched "${targetMeeting.title}" to Online (Teams)`
                            );
                          }}
                          className="flex-1 px-3 py-2 rounded-lg bg-[var(--status-ok-bg)] border border-[var(--status-ok-fg)]/30 hover:opacity-90 text-[var(--status-ok-fg)] text-xs font-bold flex items-center justify-center gap-1.5 transition-opacity cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>Confirm Online</span>
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* 3. Leave earlier meeting by HH:MM (information only, when non-overlapping) */}
                {!isOverlap && (
                  <div className="p-3 rounded-xl bg-[var(--bg-main)] border border-[var(--border)] flex items-center gap-2.5 text-xs text-[var(--text-secondary)]">
                    <Footprints className="w-4 h-4 text-[var(--sky)] shrink-0" />
                    <span className="font-medium">
                      Leave the earlier meeting by{' '}
                      <strong className="font-bold text-[var(--text-primary)]">
                        {leaveEarlierBy12h}
                      </strong>
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};
