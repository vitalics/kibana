/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import stringify from 'json-stable-stringify';
import { sortBy } from 'lodash';

import { RequestHandlerContext } from 'src/core/server';
import { TimeKey } from '../../../../common/time';
import { JsonObject } from '../../../../common/typed_json';
import {
  LogEntriesSummaryBucket,
  LogEntriesSummaryHighlightsBucket,
  LogEntry,
  LogEntriesItem,
  LogEntriesCursor,
  LogColumn,
} from '../../../../common/http_api';
import { InfraLogEntry, InfraLogMessageSegment } from '../../../graphql/types';
import {
  InfraSourceConfiguration,
  InfraSources,
  SavedSourceConfigurationFieldColumnRuntimeType,
  SavedSourceConfigurationMessageColumnRuntimeType,
  SavedSourceConfigurationTimestampColumnRuntimeType,
} from '../../sources';
import { getBuiltinRules } from './builtin_rules';
import { convertDocumentSourceToLogItemFields } from './convert_document_source_to_log_item_fields';
import {
  CompiledLogMessageFormattingRule,
  Fields,
  Highlights,
  compileFormattingRules,
} from './message';

export interface LogEntriesParams {
  startDate: number;
  endDate: number;
  size?: number;
  query?: JsonObject;
  cursor?: { before: LogEntriesCursor | 'last' } | { after: LogEntriesCursor | 'first' };
  highlightTerm?: string;
}
export interface LogEntriesAroundParams {
  startDate: number;
  endDate: number;
  size?: number;
  center: LogEntriesCursor;
  query?: JsonObject;
  highlightTerm?: string;
}

export const LOG_ENTRIES_PAGE_SIZE = 200;

export class InfraLogEntriesDomain {
  constructor(
    private readonly adapter: LogEntriesAdapter,
    private readonly libs: { sources: InfraSources }
  ) {}

  /* Name is temporary until we can clean up the GraphQL implementation */
  /* eslint-disable-next-line @typescript-eslint/camelcase */
  public async getLogEntriesAround__new(
    requestContext: RequestHandlerContext,
    sourceId: string,
    params: LogEntriesAroundParams
  ) {
    const { startDate, endDate, center, query, size, highlightTerm } = params;

    /*
     * For odd sizes we will round this value down for the first half, and up
     * for the second. This keeps the center cursor right in the center.
     *
     * For even sizes the half before is one entry bigger than the half after.
     * [1, 2, 3, 4, 5, *6*, 7, 8, 9, 10]
     *  | 5 entries |       |4 entries|
     */
    const halfSize = (size || LOG_ENTRIES_PAGE_SIZE) / 2;

    const entriesBefore = await this.getLogEntries(requestContext, sourceId, {
      startDate,
      endDate,
      query,
      cursor: { before: center },
      size: Math.floor(halfSize),
      highlightTerm,
    });

    /*
     * Elasticsearch's `search_after` returns documents after the specified cursor.
     * - If we have documents before the center, we search after the last of
     *   those. The first document of the new group is the center.
     * - If there were no documents, we search one milisecond before the
     *   center. It then becomes the first document.
     */
    const cursorAfter =
      entriesBefore.length > 0
        ? entriesBefore[entriesBefore.length - 1].cursor
        : { time: center.time - 1, tiebreaker: 0 };

    const entriesAfter = await this.getLogEntries(requestContext, sourceId, {
      startDate,
      endDate,
      query,
      cursor: { after: cursorAfter },
      size: Math.ceil(halfSize),
      highlightTerm,
    });

    return [...entriesBefore, ...entriesAfter];
  }

  /** @deprecated */
  public async getLogEntriesAround(
    requestContext: RequestHandlerContext,
    sourceId: string,
    key: TimeKey,
    maxCountBefore: number,
    maxCountAfter: number,
    filterQuery?: LogEntryQuery,
    highlightQuery?: LogEntryQuery
  ): Promise<{ entriesBefore: InfraLogEntry[]; entriesAfter: InfraLogEntry[] }> {
    if (maxCountBefore <= 0 && maxCountAfter <= 0) {
      return {
        entriesBefore: [],
        entriesAfter: [],
      };
    }

    const { configuration } = await this.libs.sources.getSourceConfiguration(
      requestContext,
      sourceId
    );
    const messageFormattingRules = compileFormattingRules(
      getBuiltinRules(configuration.fields.message)
    );
    const requiredFields = getRequiredFields(configuration, messageFormattingRules);

    const documentsBefore = await this.adapter.getAdjacentLogEntryDocuments(
      requestContext,
      configuration,
      requiredFields,
      key,
      'desc',
      Math.max(maxCountBefore, 1),
      filterQuery,
      highlightQuery
    );
    const lastKeyBefore =
      documentsBefore.length > 0
        ? documentsBefore[documentsBefore.length - 1].key
        : {
            time: key.time - 1,
            tiebreaker: 0,
          };

    const documentsAfter = await this.adapter.getAdjacentLogEntryDocuments(
      requestContext,
      configuration,
      requiredFields,
      lastKeyBefore,
      'asc',
      maxCountAfter,
      filterQuery,
      highlightQuery
    );

    return {
      entriesBefore: (maxCountBefore > 0 ? documentsBefore : []).map(
        convertLogDocumentToEntry(sourceId, configuration.logColumns, messageFormattingRules.format)
      ),
      entriesAfter: documentsAfter.map(
        convertLogDocumentToEntry(sourceId, configuration.logColumns, messageFormattingRules.format)
      ),
    };
  }

  public async getLogEntries(
    requestContext: RequestHandlerContext,
    sourceId: string,
    params: LogEntriesParams
  ): Promise<LogEntry[]> {
    const { configuration } = await this.libs.sources.getSourceConfiguration(
      requestContext,
      sourceId
    );

    const messageFormattingRules = compileFormattingRules(
      getBuiltinRules(configuration.fields.message)
    );

    const requiredFields = getRequiredFields(configuration, messageFormattingRules);

    const documents = await this.adapter.getLogEntries(
      requestContext,
      configuration,
      requiredFields,
      params
    );

    const entries = documents.map(doc => {
      return {
        id: doc.gid,
        cursor: doc.key,
        columns: configuration.logColumns.map(
          (column): LogColumn => {
            if ('timestampColumn' in column) {
              return {
                columnId: column.timestampColumn.id,
                timestamp: doc.key.time,
              };
            } else if ('messageColumn' in column) {
              return {
                columnId: column.messageColumn.id,
                message: messageFormattingRules.format(doc.fields, doc.highlights),
              };
            } else {
              return {
                columnId: column.fieldColumn.id,
                field: column.fieldColumn.field,
                value: stringify(doc.fields[column.fieldColumn.field]),
                highlights: doc.highlights[column.fieldColumn.field] || [],
              };
            }
          }
        ),
      };
    });

    return entries;
  }

  /** @deprecated */
  public async getLogEntriesBetween(
    requestContext: RequestHandlerContext,
    sourceId: string,
    startKey: TimeKey,
    endKey: TimeKey,
    filterQuery?: LogEntryQuery,
    highlightQuery?: LogEntryQuery
  ): Promise<InfraLogEntry[]> {
    const { configuration } = await this.libs.sources.getSourceConfiguration(
      requestContext,
      sourceId
    );
    const messageFormattingRules = compileFormattingRules(
      getBuiltinRules(configuration.fields.message)
    );
    const requiredFields = getRequiredFields(configuration, messageFormattingRules);
    const documents = await this.adapter.getContainedLogEntryDocuments(
      requestContext,
      configuration,
      requiredFields,
      startKey,
      endKey,
      filterQuery,
      highlightQuery
    );
    const entries = documents.map(
      convertLogDocumentToEntry(sourceId, configuration.logColumns, messageFormattingRules.format)
    );
    return entries;
  }

  /** @deprecated */
  public async getLogEntryHighlights(
    requestContext: RequestHandlerContext,
    sourceId: string,
    startKey: TimeKey,
    endKey: TimeKey,
    highlights: Array<{
      query: string;
      countBefore: number;
      countAfter: number;
    }>,
    filterQuery?: LogEntryQuery
  ): Promise<InfraLogEntry[][]> {
    const { configuration } = await this.libs.sources.getSourceConfiguration(
      requestContext,
      sourceId
    );
    const messageFormattingRules = compileFormattingRules(
      getBuiltinRules(configuration.fields.message)
    );
    const requiredFields = getRequiredFields(configuration, messageFormattingRules);

    const documentSets = await Promise.all(
      highlights.map(async highlight => {
        const highlightQuery = createHighlightQueryDsl(highlight.query, requiredFields);
        const query = filterQuery
          ? {
              bool: {
                filter: [filterQuery, highlightQuery],
              },
            }
          : highlightQuery;
        const [documentsBefore, documents, documentsAfter] = await Promise.all([
          this.adapter.getAdjacentLogEntryDocuments(
            requestContext,
            configuration,
            requiredFields,
            startKey,
            'desc',
            highlight.countBefore,
            query,
            highlightQuery
          ),
          this.adapter.getContainedLogEntryDocuments(
            requestContext,
            configuration,
            requiredFields,
            startKey,
            endKey,
            query,
            highlightQuery
          ),
          this.adapter.getAdjacentLogEntryDocuments(
            requestContext,
            configuration,
            requiredFields,
            endKey,
            'asc',
            highlight.countAfter,
            query,
            highlightQuery
          ),
        ]);
        const entries = [...documentsBefore, ...documents, ...documentsAfter].map(
          convertLogDocumentToEntry(
            sourceId,
            configuration.logColumns,
            messageFormattingRules.format
          )
        );

        return entries;
      })
    );

    return documentSets;
  }

  public async getLogSummaryBucketsBetween(
    requestContext: RequestHandlerContext,
    sourceId: string,
    start: number,
    end: number,
    bucketSize: number,
    filterQuery?: LogEntryQuery
  ): Promise<LogEntriesSummaryBucket[]> {
    const { configuration } = await this.libs.sources.getSourceConfiguration(
      requestContext,
      sourceId
    );
    const dateRangeBuckets = await this.adapter.getContainedLogSummaryBuckets(
      requestContext,
      configuration,
      start,
      end,
      bucketSize,
      filterQuery
    );
    return dateRangeBuckets;
  }

  public async getLogSummaryHighlightBucketsBetween(
    requestContext: RequestHandlerContext,
    sourceId: string,
    start: number,
    end: number,
    bucketSize: number,
    highlightQueries: string[],
    filterQuery?: LogEntryQuery
  ): Promise<LogEntriesSummaryHighlightsBucket[][]> {
    const { configuration } = await this.libs.sources.getSourceConfiguration(
      requestContext,
      sourceId
    );
    const messageFormattingRules = compileFormattingRules(
      getBuiltinRules(configuration.fields.message)
    );
    const requiredFields = getRequiredFields(configuration, messageFormattingRules);

    const summaries = await Promise.all(
      highlightQueries.map(async highlightQueryPhrase => {
        const highlightQuery = createHighlightQueryDsl(highlightQueryPhrase, requiredFields);
        const query = filterQuery
          ? {
              bool: {
                must: [filterQuery, highlightQuery],
              },
            }
          : highlightQuery;
        const summaryBuckets = await this.adapter.getContainedLogSummaryBuckets(
          requestContext,
          configuration,
          start,
          end,
          bucketSize,
          query
        );
        const summaryHighlightBuckets = summaryBuckets
          .filter(logSummaryBucketHasEntries)
          .map(convertLogSummaryBucketToSummaryHighlightBucket);
        return summaryHighlightBuckets;
      })
    );

    return summaries;
  }

  public async getLogItem(
    requestContext: RequestHandlerContext,
    id: string,
    sourceConfiguration: InfraSourceConfiguration
  ): Promise<LogEntriesItem> {
    const document = await this.adapter.getLogItem(requestContext, id, sourceConfiguration);
    const defaultFields = [
      { field: '_index', value: document._index },
      { field: '_id', value: document._id },
    ];

    return {
      id: document._id,
      index: document._index,
      key: {
        time: document.sort[0],
        tiebreaker: document.sort[1],
      },
      fields: sortBy(
        [...defaultFields, ...convertDocumentSourceToLogItemFields(document._source)],
        'field'
      ),
    };
  }
}

interface LogItemHit {
  _index: string;
  _id: string;
  _source: JsonObject;
  sort: [number, number];
}

export interface LogEntriesAdapter {
  getAdjacentLogEntryDocuments(
    requestContext: RequestHandlerContext,
    sourceConfiguration: InfraSourceConfiguration,
    fields: string[],
    start: TimeKey,
    direction: 'asc' | 'desc',
    maxCount: number,
    filterQuery?: LogEntryQuery,
    highlightQuery?: LogEntryQuery
  ): Promise<LogEntryDocument[]>;

  getLogEntries(
    requestContext: RequestHandlerContext,
    sourceConfiguration: InfraSourceConfiguration,
    fields: string[],
    params: LogEntriesParams
  ): Promise<LogEntryDocument[]>;

  getContainedLogEntryDocuments(
    requestContext: RequestHandlerContext,
    sourceConfiguration: InfraSourceConfiguration,
    fields: string[],
    start: TimeKey,
    end: TimeKey,
    filterQuery?: LogEntryQuery,
    highlightQuery?: LogEntryQuery
  ): Promise<LogEntryDocument[]>;

  getContainedLogSummaryBuckets(
    requestContext: RequestHandlerContext,
    sourceConfiguration: InfraSourceConfiguration,
    start: number,
    end: number,
    bucketSize: number,
    filterQuery?: LogEntryQuery
  ): Promise<LogSummaryBucket[]>;

  getLogItem(
    requestContext: RequestHandlerContext,
    id: string,
    source: InfraSourceConfiguration
  ): Promise<LogItemHit>;
}

export type LogEntryQuery = JsonObject;

export interface LogEntryDocument {
  fields: Fields;
  gid: string;
  highlights: Highlights;
  key: TimeKey;
}

export interface LogSummaryBucket {
  entriesCount: number;
  start: number;
  end: number;
  topEntryKeys: TimeKey[];
}

/** @deprecated */
const convertLogDocumentToEntry = (
  sourceId: string,
  logColumns: InfraSourceConfiguration['logColumns'],
  formatLogMessage: (fields: Fields, highlights: Highlights) => InfraLogMessageSegment[]
) => (document: LogEntryDocument): InfraLogEntry => ({
  key: document.key,
  gid: document.gid,
  source: sourceId,
  columns: logColumns.map(logColumn => {
    if (SavedSourceConfigurationTimestampColumnRuntimeType.is(logColumn)) {
      return {
        columnId: logColumn.timestampColumn.id,
        timestamp: document.key.time,
      };
    } else if (SavedSourceConfigurationMessageColumnRuntimeType.is(logColumn)) {
      return {
        columnId: logColumn.messageColumn.id,
        message: formatLogMessage(document.fields, document.highlights),
      };
    } else {
      return {
        columnId: logColumn.fieldColumn.id,
        field: logColumn.fieldColumn.field,
        highlights: document.highlights[logColumn.fieldColumn.field] || [],
        value: stringify(document.fields[logColumn.fieldColumn.field] || null),
      };
    }
  }),
});

const logSummaryBucketHasEntries = (bucket: LogSummaryBucket) =>
  bucket.entriesCount > 0 && bucket.topEntryKeys.length > 0;

const convertLogSummaryBucketToSummaryHighlightBucket = (
  bucket: LogSummaryBucket
): LogEntriesSummaryHighlightsBucket => ({
  entriesCount: bucket.entriesCount,
  start: bucket.start,
  end: bucket.end,
  representativeKey: bucket.topEntryKeys[0],
});

const getRequiredFields = (
  configuration: InfraSourceConfiguration,
  messageFormattingRules: CompiledLogMessageFormattingRule
): string[] => {
  const fieldsFromCustomColumns = configuration.logColumns.reduce<string[]>(
    (accumulatedFields, logColumn) => {
      if (SavedSourceConfigurationFieldColumnRuntimeType.is(logColumn)) {
        return [...accumulatedFields, logColumn.fieldColumn.field];
      }
      return accumulatedFields;
    },
    []
  );
  const fieldsFromFormattingRules = messageFormattingRules.requiredFields;

  return Array.from(new Set([...fieldsFromCustomColumns, ...fieldsFromFormattingRules]));
};

const createHighlightQueryDsl = (phrase: string, fields: string[]) => ({
  multi_match: {
    fields,
    lenient: true,
    query: phrase,
    type: 'phrase',
  },
});
