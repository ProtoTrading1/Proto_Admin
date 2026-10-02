-- Read-only, uncapped historical totals. Calling API must authenticate an admin.
-- Existing records do not identify catalogue or reliably identify preview traffic.
CREATE OR REPLACE FUNCTION public.proto_shopping_history_summary(
  p_since timestamptz,
  p_until timestamptz,
  p_excluded_customer_ids uuid[] DEFAULT ARRAY[]::uuid[],
  p_excluded_customer_emails text[] DEFAULT ARRAY[]::text[],
  p_include_internal boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  excluded_ids uuid[] := pg_catalog.array_remove(COALESCE(p_excluded_customer_ids, ARRAY[]::uuid[]), NULL);
  excluded_emails text[];
  profiles_available boolean := true;
  source record;
  metric_count bigint;
  metric_status text;
  metric_reason text;
  summary jsonb := '{}'::jsonb;
  search_summary jsonb := pg_catalog.jsonb_build_object('status','unavailable','count',NULL,'noResults',NULL,
    'unknownResults',NULL,'knownResults',NULL,'noResultRate',NULL,'daily','[]'::jsonb,'terms','[]'::jsonb,
    'termsLimit',pg_catalog.jsonb_build_object('total',NULL,'returned',0,'maximum',50,'truncated',false),
    'noResultTerms','[]'::jsonb,'noResultTermsLimit',pg_catalog.jsonb_build_object('total',NULL,'returned',0,'maximum',50,'truncated',false),
    'reason','Historical search records could not be read.');
BEGIN
  IF p_since IS NULL OR p_until IS NULL OR p_since >= p_until THEN
    RAISE EXCEPTION 'Invalid historical analytics date window' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(pg_catalog.lower(pg_catalog.btrim(value))), ARRAY[]::text[])
    INTO excluded_emails FROM pg_catalog.unnest(COALESCE(p_excluded_customer_emails,ARRAY[]::text[])) value
    WHERE value IS NOT NULL;
  IF NOT COALESCE(p_include_internal,false) THEN
    BEGIN
      SELECT excluded_ids || COALESCE(pg_catalog.array_agg(c.id), ARRAY[]::uuid[])
      INTO excluded_ids FROM public.customers c
      WHERE pg_catalog.lower(pg_catalog.btrim(COALESCE(c.role,''))) IN
        ('admin','staff','super_admin','superadmin','owner','employee')
        OR pg_catalog.lower(pg_catalog.btrim(COALESCE(c.email,''))) = ANY(excluded_emails);
    EXCEPTION WHEN undefined_table OR undefined_column OR insufficient_privilege THEN
      profiles_available := false;
    END;
  END IF;
  FOR source IN SELECT * FROM (VALUES
    ('presenceRecords','customer_visits','started_at','Existing visit records','Catalogue not recorded'),
    ('searches','search_analytics','created_at','Existing search records','Catalogue not recorded'),
    ('journeys','customer_journey_events','created_at','Existing journey records','Catalogue not recorded'),
    ('events','analytics_events','created_at','Existing activity records','Catalogue not recorded'),
    ('actualOrders','orders','created_at','Saved order records','All catalogues')
  ) AS sources(key,table_name,time_column,label,catalogue_source) LOOP
    metric_count := NULL; metric_status := 'unavailable';
    metric_reason := 'Historical source could not be read.';
    IF NOT profiles_available THEN
      metric_reason := 'Customer profiles are unavailable; internal activity cannot be fully excluded.';
    ELSE
      BEGIN
        EXECUTE pg_catalog.format('SELECT count(DISTINCT r.id) FROM public.%I r
          WHERE r.%I >= $1 AND r.%I < $2
          AND ($3 OR r.customer_id IS NULL OR NOT(r.customer_id = ANY($4)))',
          source.table_name,source.time_column,source.time_column)
          INTO metric_count USING p_since,p_until,COALESCE(p_include_internal,false),excluded_ids;
        metric_status := 'complete'; metric_reason := NULL;
      EXCEPTION WHEN undefined_table OR undefined_column OR insufficient_privilege THEN
        metric_count := NULL;
      END;
    END IF;
    summary := summary || pg_catalog.jsonb_build_object(source.key,pg_catalog.jsonb_build_object(
      'count',metric_count,'status',metric_status,'label',source.label,'source',source.catalogue_source,'reason',metric_reason));
  END LOOP;
  IF profiles_available THEN
    BEGIN
      WITH records AS MATERIALIZED (
        SELECT DISTINCT ON (r.id) r.id,r.created_at,
          pg_catalog.left(COALESCE(NULLIF(pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.btrim(
            COALESCE(NULLIF(pg_catalog.btrim(r.normalized_search_term),''),r.search_term))), '\s+', ' ', 'g'),''),'(empty term)'),200) AS term,
          r.results_found
        FROM public.search_analytics r
        WHERE r.created_at >= p_since AND r.created_at < p_until
          AND (COALESCE(p_include_internal,false) OR r.customer_id IS NULL OR NOT(r.customer_id = ANY(excluded_ids)))
        ORDER BY r.id,r.created_at
      ), days AS (
        SELECT pg_catalog.to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS date,
          count(*) AS searches,count(*) FILTER(WHERE results_found=0) AS no_results,
          count(*) FILTER(WHERE results_found IS NULL OR results_found<0) AS unknown_results
        FROM records GROUP BY 1
      ), terms AS (
        SELECT term,count(*) AS searches,count(*) FILTER(WHERE results_found=0) AS no_results,
          count(*) FILTER(WHERE results_found IS NULL OR results_found<0) AS unknown_results,
          count(*) FILTER(WHERE results_found>=0) AS known_results
        FROM records GROUP BY term
      ), top_terms AS (SELECT * FROM terms ORDER BY searches DESC,term LIMIT 50),
      failing_terms AS (SELECT * FROM terms WHERE no_results>0 ORDER BY no_results DESC,searches DESC,term LIMIT 50)
      SELECT pg_catalog.jsonb_build_object('status','complete','count',count(*),
        'noResults',count(*) FILTER(WHERE results_found=0),
        'unknownResults',count(*) FILTER(WHERE results_found IS NULL OR results_found<0),
        'knownResults',count(*) FILTER(WHERE results_found>=0),
        'noResultRate',count(*) FILTER(WHERE results_found=0)::numeric / NULLIF(count(*) FILTER(WHERE results_found>=0),0),
        'daily',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('date',date,'searches',searches,
          'noResults',no_results,'unknownResults',unknown_results) ORDER BY date) FROM days),'[]'::jsonb),
        'terms',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('term',term,'searches',searches,
          'noResults',no_results,'unknownResults',unknown_results,'noResultRate',no_results::numeric / NULLIF(known_results,0))
          ORDER BY searches DESC,term) FROM top_terms),'[]'::jsonb),
        'termsLimit',pg_catalog.jsonb_build_object('total',(SELECT count(*) FROM terms),'returned',(SELECT count(*) FROM top_terms),
          'maximum',50,'truncated',(SELECT count(*)>50 FROM terms)),
        'noResultTerms',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('term',term,'searches',searches,
          'noResults',no_results,'unknownResults',unknown_results,'noResultRate',no_results::numeric / NULLIF(known_results,0))
          ORDER BY no_results DESC,searches DESC,term) FROM failing_terms),'[]'::jsonb),
        'noResultTermsLimit',pg_catalog.jsonb_build_object('total',(SELECT count(*) FROM terms WHERE no_results>0),
          'returned',(SELECT count(*) FROM failing_terms),'maximum',50,'truncated',(SELECT count(*)>50 FROM terms WHERE no_results>0)), 'reason',NULL)
      INTO search_summary FROM records;
    EXCEPTION WHEN undefined_table OR undefined_column OR insufficient_privilege THEN
      NULL;
    END;
  ELSE
    search_summary := search_summary || pg_catalog.jsonb_build_object('reason','Customer profiles are unavailable; internal activity cannot be fully excluded.');
  END IF;
  RETURN pg_catalog.jsonb_build_object('historicalSummary',summary,'historicalSearch',search_summary,'method','database_aggregate');
END;
$function$;
REVOKE ALL ON FUNCTION public.proto_shopping_history_summary(timestamptz,timestamptz,uuid[],text[],boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.proto_shopping_history_summary(timestamptz,timestamptz,uuid[],text[],boolean) TO service_role;
COMMENT ON FUNCTION public.proto_shopping_history_summary(timestamptz,timestamptz,uuid[],text[],boolean)
IS 'Server-only read-only historical aggregates. All saved order statuses; no payment or causal conversion inference. UTC daily buckets; inclusive start and exclusive end.';
