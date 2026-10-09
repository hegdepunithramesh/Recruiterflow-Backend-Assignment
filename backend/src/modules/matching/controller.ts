import type { RequestHandler, Request } from 'express';
import { AppError } from '../../errors.js';
import { policyVersion } from './policy.js';
import type { MatchingService } from './service.js';

function validatedId(request: Request): number {
  const id = request.params.id;
  if (typeof id !== 'string' || id.length > 10 || !/^[1-9][0-9]*$/.test(id) || Number(id) > 2147483647) {
    throw new AppError('INVALID_ID');
  }
  if (Object.keys(request.query).length !== 0) throw new AppError('INVALID_QUERY');
  return Number(id);
}

export function matchingControllers(service: MatchingService): { job: RequestHandler; candidate: RequestHandler } {
  return {
    async job(request, response) {
      const { subject, matches } = await service.forJob(validatedId(request));
      response.json({ policyVersion,
        subject: { type: 'job', id: subject.id, label: subject.title, availability: null },
        matches: matches.map(({ candidate, match }) => ({ type: 'candidate', id: candidate.id,
          label: candidate.name, availability: candidate.availability, score: match.score, reason: match.reason })),
      });
    },
    async candidate(request, response) {
      const { subject, matches } = await service.forCandidate(validatedId(request));
      response.json({ policyVersion,
        subject: { type: 'candidate', id: subject.id, label: subject.name, availability: subject.availability },
        matches: matches.map(({ job, match }) => ({ type: 'job', id: job.id,
          label: job.title, availability: null, score: match.score, reason: match.reason })),
      });
    },
  };
}
