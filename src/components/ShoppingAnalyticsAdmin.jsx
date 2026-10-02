import React from 'react';
import ShoppingAnalyticsDashboard from './ShoppingAnalyticsDashboard';
import { getAccessToken } from '../lib/auth';

export default function ShoppingAnalyticsAdmin() {
  return <ShoppingAnalyticsDashboard getAccessToken={getAccessToken} />;
}
