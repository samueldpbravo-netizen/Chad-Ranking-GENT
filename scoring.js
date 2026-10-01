/* Chad Ranking scoring
 *
 * Rule: on one ballot with n ranked people, the person in place i (0 = first)
 * gets 1000 * (n - i) / n points. People the voter skipped get nothing.
 *   3 ranked -> 1000, 666.67, 333.33
 *   4 ranked -> 1000, 750, 500, 250
 * A person's score on a list = the average of their points over the ballots
 * that ranked them. The list is sorted by most points.
 *
 * Usage (works for any list: general, school, ...):
 *   const ballots = Object.values(votes).map(v => v.order);   // arrays of ids, best first, skipped people left out
 *   const ids = peopleOnThisList.map(p => p.id);
 *   const result = scoreList(ballots, ids);
 *   // result = [{ id, points, ballots, rank }, ...]  best first
 *   // points is null for someone nobody has ranked yet
 */
(function (global) {
  var MAX_POINTS = 1000;

  function ballotPoints(order) {
    var n = order.length, pts = {};
    order.forEach(function (id, i) { pts[id] = MAX_POINTS * (n - i) / n; });
    return pts;
  }

  function scoreList(ballots, ids) {
    var acc = {};
    ids.forEach(function (id) { acc[id] = { id: id, sum: 0, n: 0 }; });

    ballots.forEach(function (order) {
      // keep only people on this list (also drops duplicates)
      var seen = {}, clean = (order || []).filter(function (id) {
        if (!acc[id] || seen[id]) return false;
        seen[id] = true; return true;
      });
      // a ballot with only one ranked person would hand out a free 1000, so it is ignored
      if (clean.length < 2) return;
      var pts = ballotPoints(clean);
      clean.forEach(function (id) { acc[id].sum += pts[id]; acc[id].n++; });
    });

    var out = Object.keys(acc).map(function (id) {
      var a = acc[id];
      return { id: id, ballots: a.n, points: a.n ? a.sum / a.n : null };
    });

    out.sort(function (x, y) {
      if (x.points == null && y.points == null) return 0;
      if (x.points == null) return 1;
      if (y.points == null) return -1;
      return (y.points - x.points) || (y.ballots - x.ballots);
    });
    out.forEach(function (e, i) { e.rank = i + 1; });
    return out;
  }

  global.scoreList = scoreList;
  global.ballotPoints = ballotPoints;
})(window);
