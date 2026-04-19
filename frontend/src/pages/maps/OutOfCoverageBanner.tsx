/**
 * Floating pill shown at the top-centre of the map when the current
 * viewport falls outside every installed region and the browser is
 * offline — the one state where we cannot render anything useful.
 *
 * Includes a deep-link back to Settings → Maps so the user can install
 * a larger region without leaving the app.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { MapPinOff, ArrowRight } from 'lucide-react';
import { MANAGE_MAPS_ROUTE } from './routes';

const OutOfCoverageBanner: React.FC = () => (
  <div
    role="status"
    aria-live="polite"
    className="pointer-events-auto flex items-center gap-2 rounded-full border border-border/30 bg-card/95 px-4 py-2 text-xs shadow-m2 backdrop-blur"
  >
    <MapPinOff size={14} className="text-muted-foreground" />
    <span className="text-foreground">No tiles here — install a larger region</span>
    <Link
      to={MANAGE_MAPS_ROUTE}
      className="flex items-center gap-1 rounded-full bg-primary/15 px-2.5 py-0.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/25"
    >
      Open Settings <ArrowRight size={11} />
    </Link>
  </div>
);

export default OutOfCoverageBanner;
