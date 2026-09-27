import React, { useState, useMemo } from "react";
import { useDatabase } from "./context/DatabaseContext";
import useCurrentLocation from "./hooks/useCurrentLocation";
import SearchBar from "./components/common/SearchBar";
import SearchChips from "./components/common/SearchChips";
import BottomSheet from "./components/common/BottomSheet";
import YDCard from "./components/common/YDCard";
import CampusMap from "./components/map/CampusMap";
import LoadingScreen from "./components/common/LoadingScreen";
import LandingScreen from "./components/common/LandingScreen";
import LiveEventsModal from "./components/common/LiveEventsModal";
import NavigationCard from "./components/common/NavigationCard";
import FeedbackCard from "./components/common/FeedbackCard";
import LocationAlertCard from "./components/common/LocationAlertCard";
import YDRouteCard from "./components/common/YDRouteCard";
import CampusCompassEmblem from "./components/common/CampusCompassEmblem";
import { buildNodeMap, findNearestOutdoorNode, findOutdoorPath } from "./routing/outdoorRouter";
import { findMatchingBuildingNode } from "./utils/buildingMatcher";
import { gpsDistanceMeters } from "./utils/gpsDistance";
import { getDistanceToRoute } from "./utils/distanceToRoute";
import "./App.css";

// Default user position if GPS unavailable (Campus Entrance)
const DEFAULT_USER_POS = [10.361964, 76.285827];

export default function App() {
  const { loading: dbLoading, events, nodes, edges, searchItems } = useDatabase();
  const { location, heading: compassHeading, gpsStatus, startTracking, getOneShotLocation, requestCompassPermission } = useCurrentLocation();

  // Minimalist Splash / Landing Screen State
  const [showLanding, setShowLanding] = useState(true);

  // Live Events Popup Modal State on First Load
  const [showLiveModal, setShowLiveModal] = useState(false);

  const [selectedLocation, setSelectedLocation] = useState(null);
  const [destination, setDestination] = useState(null);
  const [customOrigin, setCustomOrigin] = useState(null); // null means Live GPS / Your Location
  const [route, setRoute] = useState([]);
  const [isNavigating, setIsNavigating] = useState(false);

  // Keep route state synced in a ref for safe off-route checks without re-render loops
  const routeRef = React.useRef(route);
  React.useEffect(() => {
    routeRef.current = route;
  }, [route]);


  const [showFeedbackCard, setShowFeedbackCard] = useState(false);
  const [feedbackDestination, setFeedbackDestination] = useState(null);

  // GPS Alert Dismissal state
  const [dismissGpsAlert, setDismissGpsAlert] = useState(false);

  // Default to Real GPS location mode
  const [useDefaultLocation, setUseDefaultLocation] = useState(false);

  const handleRetryGps = async () => {
    startTracking();
    await getOneShotLocation();
  };

  // BottomSheet State
  const [bottomSheetOpen, setBottomSheetOpen] = useState(false);
  const [selectedBuilding, setSelectedBuilding] = useState("Main");
  const [activeCategory, setActiveCategory] = useState(null);

  // Ref to the LiveEventsModal so we can call handleBack() for category drill-down
  const liveModalRef = React.useRef(null);

  // ─── Android / PWA Hardware Back Button ─────────────────────────────────
  // History API sentinel pattern: one extra history entry is always maintained
  // so popstate fires before Android exits/minimises the PWA.
  // All live UI state is read through _backStateRef to avoid stale closures in
  // the empty-dep effect.
  // Priority: FeedbackCard → BottomSheet → Modal (category) → Modal → Navigation → Route
  // ─────────────────────────────────────────────────────────────────
  const _backStateRef = React.useRef({});
  React.useEffect(() => {
    _backStateRef.current = {
      showFeedbackCard, bottomSheetOpen, showLiveModal, isNavigating, destination,
    };
  }, [showFeedbackCard, bottomSheetOpen, showLiveModal, isNavigating, destination]);

  React.useEffect(() => {
    window.history.pushState(null, ''); // Push initial sentinel

    const handleBackButton = () => {
      const s = _backStateRef.current;
      let consumed = false;

      if (s.showFeedbackCard) {
        setShowFeedbackCard(false);
        consumed = true;
      } else if (s.bottomSheetOpen) {
        setBottomSheetOpen(false);
        consumed = true;
      } else if (s.showLiveModal && liveModalRef.current?.handleBack()) {
        consumed = true; // Modal handled it: event list → category grid
      } else if (s.showLiveModal) {
        setShowLiveModal(false);
        consumed = true;
      } else if (s.isNavigating || s.destination) {
        setRoute([]);
        setIsNavigating(false);
        setDestination(null);
        setSelectedLocation(null);
        setCustomOrigin(null);
        consumed = true;
      }

      if (consumed) {
        window.history.pushState(null, ''); // Restore sentinel for next press
      }
      // Not consumed → browser handles naturally (exits / minimises PWA)
    };

    window.addEventListener('popstate', handleBackButton);
    return () => window.removeEventListener('popstate', handleBackButton);
  }, []); // Empty — reads live values through _backStateRef
  // ─────────────────────────────────────────────────────────────────

  // Build dynamic node map lookup { [id]: [lat, lng] } from DB nodes
  const nodeMap = useMemo(() => {
    return buildNodeMap(nodes);
  }, [nodes]);

  // Check if live GPS position fix is actively available
  const isLiveGps = Boolean(
    location &&
    Array.isArray(location) &&
    location.length === 2 &&
    !isNaN(location[0]) &&
    !isNaN(location[1])
  );

  // Auto detect if device GPS is off-campus (> 1.2 km from campus entrance)
  const isGpsOffCampus = useMemo(() => {
    if (!isLiveGps) return true;
    const dist = gpsDistanceMeters(location, DEFAULT_USER_POS);
    return dist > 1200;
  }, [location, isLiveGps]);

  // Computed active user coordinates
  const userCoords = useMemo(() => {
    // If Test Mode is explicitly enabled by user, use Campus Entrance
    if (useDefaultLocation) {
      return DEFAULT_USER_POS;
    }
    // Prioritize real-time device GPS location
    if (isLiveGps) {
      return location;
    }
    // Fallback to campus entrance when live GPS fix is not available
    return DEFAULT_USER_POS;
  }, [location, isLiveGps, useDefaultLocation]);

  // Active starting coordinates (uses customOrigin if selected by user, otherwise userCoords)
  const activeStartCoords = useMemo(() => {
    if (customOrigin && customOrigin.position && Array.isArray(customOrigin.position)) {
      return customOrigin.position;
    }
    return userCoords;
  }, [customOrigin, userCoords]);

  // Helper string cleaner
  const cleanStr = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  // Display coords for the user icon:
  // Within 8 m of the path → snap icon to the nearest point ON the path so it
  // travels smoothly along the line even when GPS noise pushes the raw fix sideways.
  // Beyond 8 m → use real GPS (and the dotted connector + reroute will kick in).
  const displayUserCoords = useMemo(() => {
    if (route && route.length >= 2 && userCoords) {
      const userLoc = { lat: userCoords[0], lng: userCoords[1] };
      const { point, distanceMeters } = getDistanceToRoute(route, userLoc);
      if (distanceMeters <= 8 && point && Array.isArray(point)) {
        return point; // icon glued to path line
      }
    }
    return userCoords;
  }, [route, userCoords]);

  // Off-route connector: {userPoint:[lat,lng], pathPoint:[lat,lng]}
  // Set when user is >8 m from the route; cleared when back on route.
  const [offRouteConnector, setOffRouteConnector] = React.useState(null);

  // Live dynamic route update with off-route threshold (8m) & smooth path reduction
  React.useEffect(() => {
    if (!destination) return;

    const currentRoute = routeRef.current;
    const userLoc = { lat: activeStartCoords[0], lng: activeStartCoords[1] };

    // If an active route already exists, check distance to current route line
    if (currentRoute && currentRoute.length >= 2) {
      const { point, distanceMeters, segmentIndex } = getDistanceToRoute(currentRoute, userLoc);

      // Within 8 m of the path — user is ON route, keep current path
      if (distanceMeters <= 8) {
        setOffRouteConnector(null); // clear connector — user is on path
        // Snap path origin to route if within 8m, otherwise use activeStartCoords
        const startPoint = (distanceMeters <= 8 && point && Array.isArray(point)) ? point : activeStartCoords;
        const remainingSegment = currentRoute.slice(segmentIndex + 1);
        const updatedRoute = [startPoint, ...remainingSegment];

        if (updatedRoute.length >= 2) {
          setRoute(updatedRoute);
        }
        return;
      }

      // User is >8 m off-route: show dotted connector while rerouting
      if (point && Array.isArray(point)) {
        setOffRouteConnector({ userPoint: activeStartCoords, pathPoint: point });
      }
    }

    // User is > 8m OFF-ROUTE (or route is brand new/empty): recalculate A* path from user's current location
    const startNodeId = findNearestOutdoorNode(activeStartCoords[0], activeStartCoords[1], nodeMap);
    const isEvent = destination.type === 'event' || Boolean(destination.event_name) || Boolean(destination.speakers);

    let destPos = destination.position && Array.isArray(destination.position) && destination.position.length === 2 && !isNaN(destination.position[0]) && !isNaN(destination.position[1])
      ? destination.position
      : null;

    if (!destPos && destination.routeNode && nodeMap[destination.routeNode]) {
      destPos = nodeMap[destination.routeNode];
    }

    let matchingNode = null;
    if (!destPos) {
      const buildingToMatch = destination.building || destination.name || destination.event_name;
      matchingNode = findMatchingBuildingNode(buildingToMatch, nodes);
      if (matchingNode && matchingNode.latitude && matchingNode.longitude) {
        destPos = [parseFloat(matchingNode.latitude), parseFloat(matchingNode.longitude)];
      }
    }

    let destNodeId = null;
    if (destination.routeNode && nodeMap[destination.routeNode]) {
      destNodeId = destination.routeNode;
    } else if (matchingNode && matchingNode.id && nodeMap[matchingNode.id]) {
      destNodeId = matchingNode.id;
    } else if (!isEvent && destination.id && nodeMap[destination.id]) {
      destNodeId = destination.id;
    } else if (destPos) {
      destNodeId = findNearestOutdoorNode(destPos[0], destPos[1], nodeMap);
    }

    let pathNodeIds = [];
    if (startNodeId && destNodeId) {
      if (startNodeId === destNodeId) {
        pathNodeIds = [startNodeId];
      } else {
        pathNodeIds = findOutdoorPath(startNodeId, destNodeId, nodeMap, edges);
      }
    }

    let routeNodes = pathNodeIds
      .map((id) => nodeMap[id])
      .filter((coord) => coord && Array.isArray(coord) && coord.length === 2 && !isNaN(coord[0]) && !isNaN(coord[1]));

    if (routeNodes.length >= 2) {
      const userLoc = { lat: activeStartCoords[0], lng: activeStartCoords[1] };
      const { point, distanceMeters, segmentIndex } = getDistanceToRoute(routeNodes, userLoc);

      if (distanceMeters <= 8 && point && Array.isArray(point)) {
        // Within 8m: Snap route origin directly to point ON path line segment!
        const remainingSegment = routeNodes.slice(segmentIndex + 1);
        const routeCoords = [point, ...remainingSegment];
        setRoute(routeCoords.length >= 2 ? routeCoords : routeNodes);
        setOffRouteConnector(null);
      } else {
        // > 8m off-route: keep route starting on graph, set dotted connector
        setRoute(routeNodes);
        if (point && Array.isArray(point)) {
          setOffRouteConnector({ userPoint: activeStartCoords, pathPoint: point });
        }
      }
    } else if (destPos) {
      setRoute([activeStartCoords, destPos]);
    }
  }, [activeStartCoords, destination, nodeMap, nodes, edges]);

  // Calculate live distance in meters from active user location to destination
  const distanceToDestMeters = useMemo(() => {
    if (!destination || !destination.position || !userCoords) return Infinity;
    return gpsDistanceMeters(userCoords, destination.position);
  }, [destination, userCoords]);

  // Near building threshold (e.g. within 30 meters of destination building)
  const isNearBuilding = useMemo(() => {
    return isNavigating && distanceToDestMeters <= 30;
  }, [isNavigating, distanceToDestMeters]);

  // Handle selecting a destination (Route Preview Mode: shows path on map + preview card)
  const handleSelectDestination = (targetItem = null) => {
    if (!targetItem) return;

    const isEvent = targetItem.type === 'event' || Boolean(targetItem.event_name) || Boolean(targetItem.speakers);

    // 1. Resolve destination position (destPos)
    let destPos = targetItem.position && Array.isArray(targetItem.position) && targetItem.position.length === 2 && !isNaN(targetItem.position[0]) && !isNaN(targetItem.position[1])
      ? targetItem.position
      : null;

    if (!destPos && targetItem.routeNode && nodeMap[targetItem.routeNode]) {
      destPos = nodeMap[targetItem.routeNode];
    }

    let matchingNode = null;
    if (!destPos) {
      const buildingToMatch = targetItem.building || targetItem.name || targetItem.event_name;
      matchingNode = findMatchingBuildingNode(buildingToMatch, nodes);
      if (matchingNode && matchingNode.latitude && matchingNode.longitude) {
        destPos = [parseFloat(matchingNode.latitude), parseFloat(matchingNode.longitude)];
      }
    }

    // 2. Resolve destination node ID (destNodeId) — prioritize routeNode over event id!
    let destNodeId = null;
    if (targetItem.routeNode && nodeMap[targetItem.routeNode]) {
      destNodeId = targetItem.routeNode;
    } else if (matchingNode && matchingNode.id && nodeMap[matchingNode.id]) {
      destNodeId = matchingNode.id;
    } else if (!isEvent && targetItem.id && nodeMap[targetItem.id]) {
      destNodeId = targetItem.id;
    } else if (destPos) {
      destNodeId = findNearestOutdoorNode(destPos[0], destPos[1], nodeMap);
    }

    const startNodeId = findNearestOutdoorNode(activeStartCoords[0], activeStartCoords[1], nodeMap);

    let pathNodeIds = [];
    if (startNodeId && destNodeId) {
      if (startNodeId === destNodeId) {
        pathNodeIds = [startNodeId];
      } else {
        pathNodeIds = findOutdoorPath(startNodeId, destNodeId, nodeMap, edges);
      }
    }

    let routeNodes = pathNodeIds
      .map((id) => nodeMap[id])
      .filter((coord) => coord && Array.isArray(coord) && coord.length === 2 && !isNaN(coord[0]) && !isNaN(coord[1]));

    let finalRoute = routeNodes;
    if (routeNodes.length >= 2) {
      const userLoc = { lat: activeStartCoords[0], lng: activeStartCoords[1] };
      const { point, distanceMeters, segmentIndex } = getDistanceToRoute(routeNodes, userLoc);

      if (distanceMeters <= 8 && point && Array.isArray(point)) {
        // Within 8m: Snap route origin directly to point ON path line segment!
        const remainingSegment = routeNodes.slice(segmentIndex + 1);
        finalRoute = [point, ...remainingSegment];
        setOffRouteConnector(null);
      } else {
        finalRoute = routeNodes;
        if (point && Array.isArray(point)) {
          setOffRouteConnector({ userPoint: activeStartCoords, pathPoint: point });
        }
      }
    } else if (destPos) {
      finalRoute = [activeStartCoords, destPos];
      setOffRouteConnector(null);
    } else if (routeNodes.length === 1) {
      finalRoute = [activeStartCoords, routeNodes[0]];
      setOffRouteConnector(null);
    }

    const resolvedDestination = {
      ...targetItem,
      type: isEvent ? 'event' : (targetItem.type || 'location'),
      routeNode: destNodeId,
      position: destPos || (finalRoute.length > 0 ? finalRoute[finalRoute.length - 1] : activeStartCoords)
    };

    setRoute(finalRoute);
    setDestination(resolvedDestination);
    setSelectedLocation(targetItem);
    setIsNavigating(false); // Keeps in Route Preview mode until user clicks "Start Navigation"
    setBottomSheetOpen(false);

    if (targetItem.type === "event" || targetItem.type === "location" || targetItem.building) {
      setSelectedBuilding(targetItem.building || targetItem.name || "Campus Location");
    }
  };

  // Confirm Start Navigation (User clicks "Start Navigation" button on YDCard)
  const handleConfirmStartNavigation = () => {
    if (!destination) return;
    setIsNavigating(true);
    setBottomSheetOpen(false);
  };

  // Handle selecting category chips
  const handleSelectCategory = (catId) => {
    setActiveCategory(catId);
    setBottomSheetOpen(true);
  };

  // Filter events strictly for current activeCategory in BottomSheet using database events
  const categoryEvents = useMemo(() => {
    const eventItems = (events || []).map(e => ({
      ...e,
      type: 'event',
      name: e.event_name,
      event_category: e.event_category || e.category || 'Check In'
    }));
    if (!eventItems || eventItems.length === 0) return [];
    if (!activeCategory) return eventItems;

    const normActive = activeCategory.trim().toLowerCase();

    return eventItems.filter((e) => {
      const cat = (e.event_category || e.category || '').trim().toLowerCase();
      if (!cat) return false;
      return cat === normActive || cat.includes(normActive) || normActive.includes(cat);
    });
  }, [events, activeCategory]);

  // Cancel / Stop Navigation
  const handleCancelNavigation = () => {
    setRoute([]);
    setIsNavigating(false);
    setDestination(null);
    setSelectedLocation(null);
    setCustomOrigin(null);
  };

  // Swap origin and destination in YDRouteCard
  const handleSwapYD = () => {
    if (!destination) return;
    const oldDest = destination;
    const oldOrigin = customOrigin;
    setDestination(oldOrigin || { name: "Your Location", position: userCoords });
    setCustomOrigin(oldDest);
  };

  // Close YDRouteCard & exit route mode
  const handleCloseYD = () => {
    setCustomOrigin(null);
    handleCancelNavigation();
  };

  // Reached Destination -> Open Feedback Modal
  const handleReachedDestination = () => {
    setFeedbackDestination(destination);
    setRoute([]);
    setIsNavigating(false);
    setDestination(null);
    setSelectedLocation(null);
    setShowFeedbackCard(true);
  };

  // Universal Back Button Handler for Top-Left Header Bar
  const handleBackClick = () => {
    if (showFeedbackCard) {
      setShowFeedbackCard(false);
    } else if (bottomSheetOpen) {
      setBottomSheetOpen(false);
    } else if (showLiveModal) {
      setShowLiveModal(false);
    } else if (destination || isNavigating) {
      handleCancelNavigation();
    } else if (activeCategory) {
      setActiveCategory(null);
    } else {
      const fallback = () => { window.location.href = "https://webapp.iedcsummit.in/"; };
      if (document.referrer) {
        // Skip our popstate sentinel + this app entry to reach the previous page
        let left = false;
        window.addEventListener("pagehide", () => { left = true; }, { once: true });
        window.history.go(-2);
        // If nothing happened (e.g. opened in a new tab with a referrer), redirect
        setTimeout(() => { if (!left && document.visibilityState === "visible") fallback(); }, 400);
      } else {
        fallback();
      }
    }
  };

  if (dbLoading) {
    return <LoadingScreen message="Loading IEDC Summit Outdoor Map..." />;
  }

  return (
    <div className="fixed inset-0 w-full h-full h-[100dvh] overflow-hidden bg-gray-50 flex flex-col touch-none select-none">
      {/* Minimalist Splash / Loading Screen */}
      {showLanding && (
        <LandingScreen
          onFinish={() => {
            setShowLanding(false);
            setShowLiveModal(true); // Open live events popup on map load
            // Request DeviceOrientation permission here — this callback fires from
            // a user button tap, which is the only valid gesture iOS 13+ accepts.
            // On Android / non-iOS this is a no-op (returns "not-required" instantly).
            requestCompassPermission();
          }}
        />
      )}

      {/* Live Events Popup Modal on First Map Load */}
      {!showLanding && showLiveModal && (
        <LiveEventsModal
          ref={liveModalRef}
          events={(searchItems || []).filter(i => i.type === 'event')}
          onNavigate={(event) => {
            handleSelectDestination(event);
          }}
          onClose={() => setShowLiveModal(false)}
        />
      )}

      {/* Top Floating Control Bar */}
      <div className="absolute top-[calc(0.75rem+env(safe-area-inset-top))] left-0 right-0 z-40 px-3 sm:px-4 max-w-lg mx-auto pointer-events-none flex flex-col gap-2">
        {!destination && (
          <div className="w-full bg-white/95 backdrop-blur-md px-3 py-2 rounded-2xl shadow-md border border-gray-200/80 flex items-center justify-between pointer-events-auto">
            <div className="flex items-center gap-2">
              <button
                onClick={handleBackClick}
                className="w-8 h-8 flex items-center justify-center bg-gray-100/90 hover:bg-gray-200 active:scale-90 text-gray-700 rounded-xl transition-all cursor-pointer border border-gray-200/60 shrink-0"
                title="Go Back"
                aria-label="Go Back"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="19" y1="12" x2="5" y2="12"></line>
                  <polyline points="12 19 5 12 12 5"></polyline>
                </svg>
              </button>
              <CampusCompassEmblem size="small" />
            </div>

            <button
              onClick={() => setShowLiveModal(true)}
              className="flex items-center gap-2 px-3.5 py-1.5 bg-gradient-to-r from-[#0F4C81] to-[#003DA5] text-white rounded-xl text-xs font-extrabold shadow-sm hover:brightness-110 active:scale-95 transition-all cursor-pointer"
              title="Open Live Events Guide Popup"
            >
              <span className="w-2.5 h-2.5 rounded-full bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.9)] animate-pulse"></span>
              <span>Events</span>
            </button>
          </div>
        )}

        <div className="w-full pointer-events-auto">
          {destination ? (
            <YDRouteCard
              destination={destination}
              origin={customOrigin}
              onSelectDestination={(newDest) => {
                handleSelectDestination(newDest);
              }}
              onSelectOrigin={(newOrig) => {
                setCustomOrigin(newOrig);
              }}
              onSwap={handleSwapYD}
              onClose={handleCloseYD}
            />
          ) : (
            <SearchBar
              onNavigate={(item) => {
                handleSelectDestination(item);
              }}
              onClear={() => {
                handleCancelNavigation();
              }}
            />
          )}
        </div>

        {!destination && (
          <SearchChips
            onSelectCategory={handleSelectCategory}
            activeCategory={activeCategory}
          />
        )}
      </div>

      {/* Main Outdoor Map */}
      <div className="w-full h-full z-0">
        <CampusMap
          selectedLocation={selectedLocation}
          currentLocation={displayUserCoords}
          isLiveGps={isLiveGps}
          heading={compassHeading}
          route={route}
          destination={destination}
          isNavigating={isNavigating}
          offRouteConnector={offRouteConnector}
          onSelectLocation={(loc) => {
            // Only allow tapping map icons to show path when user has NOT searched yet
            if (!destination) {
              handleSelectDestination(loc);
            }
          }}
        />
      </div>


      {/* Route Preview Info Card (Shows route path on map + preview card with Cancel and Start Navigation) */}
      {destination && !isNavigating && !bottomSheetOpen && (
        <YDCard
          destination={destination}
          route={route}
          onStart={handleConfirmStartNavigation}
          onCancel={handleCancelNavigation}
        />
      )}

      {/* Active Navigation Card (Compact floating 'Cancel Navigation' bar mid-route; automatically expands into Building Info Card when near building) */}
      {isNavigating && (
        <NavigationCard
          destination={destination}
          isNearBuilding={isNearBuilding}
          onCancel={handleCancelNavigation}
          onReached={handleReachedDestination}
        />
      )}

      {/* Post-Navigation Feedback Modal */}
      {(showFeedbackCard) && (
        <FeedbackCard
          destination={feedbackDestination || { name: 'IEDC Summit 2026', type: 'event', event_name: 'IEDC Summit 2026' }}
          onClose={() => setShowFeedbackCard(false)}
        />
      )}

      {/* Location Access Denied / Turn On GPS Alert Card */}
      {!showLanding && (gpsStatus === "failed" || gpsStatus === "timeout") && !dismissGpsAlert && (
        <LocationAlertCard
          onRetry={handleRetryGps}
          onClose={() => setDismissGpsAlert(true)}
        />
      )}

      {/* Event Timeline Bottom Sheet */}
      <BottomSheet
        isOpen={bottomSheetOpen}
        onClose={() => setBottomSheetOpen(false)}
        buildingName={activeCategory || selectedBuilding || "Event Category"}
        events={categoryEvents}
        onNavigate={(event) => {
          handleSelectDestination(event);
        }}
      />
    </div>
  );
}

