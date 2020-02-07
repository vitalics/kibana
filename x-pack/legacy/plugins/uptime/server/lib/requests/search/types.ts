/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { CursorDirection, SortOrder } from '../../../../common/graphql/types';

export interface CursorPagination {
  cursorKey?: any;
  cursorDirection: CursorDirection;
  sortOrder: SortOrder;
}
