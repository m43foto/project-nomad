// [fork: resume-indexing]
// Lists ZIM ingestions whose batch chain broke (container restart, host sleep,
// crash) and lets the user continue each one from its last batch offset instead
// of re-indexing the whole archive from article 0.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import StyledButton from '~/components/StyledButton'
import { useNotifications } from '~/context/NotificationContext'
import api from '~/lib/api'
import { formatTimeAgo } from '~/lib/kb_job_health_display'

interface ResumableEmbedJobsProps {
  disabled?: boolean
}

const ResumableEmbedJobs = ({ disabled = false }: ResumableEmbedJobsProps) => {
  const queryClient = useQueryClient()
  const { addNotification } = useNotifications()

  const { data: jobs = [] } = useQuery({
    queryKey: ['resumableEmbedJobs'],
    queryFn: () => api.getResumableEmbedJobs().then((data) => data ?? []),
    refetchInterval: 30000,
  })

  const resumeMutation = useMutation({
    mutationFn: (filePath: string) => api.resumeEmbedJob(filePath),
    onSuccess: (data) => {
      if (data) {
        const removed =
          data.removedPoints > 0
            ? ` Removed ${data.removedPoints.toLocaleString()} partial chunks of the interrupted batch.`
            : ''
        addNotification({ type: 'success', message: `${data.message}${removed}` })
      }
      queryClient.invalidateQueries({ queryKey: ['resumableEmbedJobs'] })
      queryClient.invalidateQueries({ queryKey: ['embed-jobs'] })
    },
    onError: (error: any) => {
      addNotification({ type: 'error', message: error?.message || 'Failed to resume indexing.' })
    },
  })

  if (jobs.length === 0) return null

  return (
    <div className="space-y-4 mb-4">
      {jobs.map((job) => {
        const pending = resumeMutation.isPending && resumeMutation.variables === job.filePath
        return (
          <div
            key={job.jobId}
            className="bg-desert-white rounded-lg p-4 border border-desert-orange shadow-sm"
          >
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-3 mb-1">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full bg-desert-orange"
                    aria-label="Interrupted"
                    title="Interrupted"
                  />
                  <span className="text-sm font-medium text-text-primary">Interrupted</span>
                  {job.failedAt !== undefined && (
                    <span className="text-xs text-text-muted">
                      · stopped {formatTimeAgo(job.failedAt, Date.now())}
                    </span>
                  )}
                </div>
                <p className="text-sm text-text-primary break-all">{job.fileName}</p>
                <p className="text-xs text-text-muted mt-1">
                  Stopped at article {job.batchOffset.toLocaleString()}
                  {job.totalArticles ? ` of ${job.totalArticles.toLocaleString()}` : ''} (
                  {job.progress}%) · {job.chunksSoFar.toLocaleString()} chunks indexed
                  {job.failedReason ? ` · ${job.failedReason}` : ''}
                </p>
              </div>
              <StyledButton
                variant="primary"
                size="md"
                icon="IconPlayerPlay"
                onClick={() => resumeMutation.mutate(job.filePath)}
                loading={pending}
                disabled={disabled || resumeMutation.isPending}
                title="Continue indexing from the interrupted batch. Chunks the interrupted batch had already written are removed first, so nothing is duplicated."
              >
                Resume Indexing
              </StyledButton>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default ResumableEmbedJobs
