import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { FloatingGenerateBox } from '@/components/Generation/FloatingGenerateBox';
import { Button } from '@/components/ui/button';
import { useMediaQuery } from '@/lib/hooks/useMediaQuery';
import { useStoryStore } from '@/stores/storyStore';
import { StoryContent } from './StoryContent';
import { StoryList } from './StoryList';

export function StoriesTab() {
  const { t } = useTranslation();
  const compact = useMediaQuery('(max-width: 899px)');
  const selectedStoryId = useStoryStore((state) => state.selectedStoryId);
  const listRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const showBack = compact && !!selectedStoryId;

  useEffect(() => {
    if (showBack) backRef.current?.focus();
  }, [showBack]);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden sm:-mx-6 lg:-mx-8 desktop-page-bleed">
      {/* Main content area */}
      <div ref={listRef} className="relative flex min-h-0 flex-1 overflow-hidden">
        <StoryList
          selectFirst={false}
          showEmptyDetail={!compact && !selectedStoryId}
          className={
            showBack ? 'hidden' : 'w-full shrink-0 min-[900px]:w-[300px] xl:w-[340px]'
          }
        />

        {selectedStoryId && (
          <>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden sm:px-4 min-[900px]:px-6">
              {showBack && (
                <Button
                  ref={backRef}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mb-1 shrink-0 self-start px-2"
                  aria-label={t('stories.back')}
                  onClick={() => {
                    const storyState = useStoryStore.getState();
                    storyState.stop();
                    storyState.setSelectedClipId(null);
                    storyState.setSelectedStoryId(null);
                    requestAnimationFrame(() => listRef.current?.querySelector('input')?.focus());
                  }}
                >
                  <ArrowLeft className="h-4 w-4" />
                  {t('stories.title')}
                </Button>
              )}
              <StoryContent composer={compact ? <FloatingGenerateBox layout="docked" /> : undefined} />
            </div>
            {!compact && <FloatingGenerateBox showVoiceSelector />}
          </>
        )}
      </div>
    </div>
  );
}
