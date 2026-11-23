import React from 'react';
import {
  Building2,
  ArrowRight,
  Sparkles,
  Calendar,
} from 'lucide-react';

interface WelcomeHeroPageProps {
  onStartSampleWalkthrough: () => void;
  onOpenNextMeeting: () => void;
  onConnectCalendar: () => void;
}

export const WelcomeHeroPage: React.FC<WelcomeHeroPageProps> = ({
  onStartSampleWalkthrough,
  onConnectCalendar,
}) => {
  const isPublicDemo = import.meta.env.VITE_PUBLIC_DEMO === 'true';

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 min-h-[calc(100vh-5rem)] flex flex-col items-center justify-center py-12 animate-in fade-in duration-200">
      <section className="text-center space-y-8 w-full">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[var(--sky-tint)] border border-[var(--sky)] text-[var(--sky-strong)] text-xs font-semibold shadow-2xs">
          <Building2 className="w-3.5 h-3.5 text-[var(--sky)]" />
          <span>University of Waterloo · QuestFlow</span>
        </div>

        <h1 className="text-3xl sm:text-5xl font-extrabold text-[var(--text-primary)] tracking-tight leading-[1.15] max-w-3xl mx-auto">
          Arrive on time to every meeting at the University of Waterloo.
        </h1>

        <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center justify-center gap-3.5 pt-2">
          <button
            type="button"
            onClick={onStartSampleWalkthrough}
            className="px-6 py-4 text-sm font-bold text-white bg-[var(--sky-strong)] hover:bg-[var(--sky-hover)] rounded-xl shadow-md transition-all flex items-center justify-center gap-2.5 cursor-pointer active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sky-strong)] focus-visible:ring-offset-2"
          >
            <Sparkles className="w-4 h-4 shrink-0" />
            <span>Try the tutorial</span>
            <ArrowRight className="w-4 h-4 shrink-0" />
          </button>

          <button
            type="button"
            onClick={onConnectCalendar}
            className="px-6 py-4 text-sm font-semibold text-[var(--text-primary)] bg-[var(--bg-card)] hover:bg-[var(--bg-hover)] border border-[var(--border)] rounded-xl transition-all shadow-2xs flex items-center justify-center gap-2.5 cursor-pointer active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sky-strong)] focus-visible:ring-offset-2"
          >
            <Calendar className="w-4 h-4 shrink-0 text-[var(--sky)]" />
            <span>Input My Calendar</span>
            <ArrowRight className="w-4 h-4 shrink-0 opacity-60" />
          </button>
        </div>

        {isPublicDemo && (
          <p className="text-xs sm:text-sm text-[var(--text-secondary)] font-medium">
            Public demo — try the tutorial. Calendar sync is shown at our booth.
          </p>
        )}
      </section>
    </div>
  );
};
