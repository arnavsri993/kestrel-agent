import Foundation
import CoreLocation
import Combine

public class LocationNodeService: NSObject, CLLocationManagerDelegate {
    public static let shared = LocationNodeService()

    private let locationManager = CLLocationManager()
    private var currentLocation: CLLocation?
    private var locationContinuation: CheckedContinuation<CLLocation?, Never>?

    override private init() {
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    public func requestAuthorization() {
        locationManager.requestWhenInUseAuthorization()
    }

    public func getCurrentLocation(accuracy: String = "balanced") async -> CLLocation? {
        let authStatus = locationManager.authorizationStatus
        guard authStatus == .authorizedWhenInUse || authStatus == .authorizedAlways else {
            return nil
        }

        switch accuracy {
        case "precise":
            locationManager.desiredAccuracy = kCLLocationAccuracyBest
        case "coarse":
            locationManager.desiredAccuracy = kCLLocationAccuracyKilometer
        default:
            locationManager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        }

        return await withCheckedContinuation { continuation in
            self.locationContinuation = continuation
            locationManager.requestLocation()
        }
    }

    // CLLocationManagerDelegate
    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        if let location = locations.last {
            currentLocation = location
            locationContinuation?.resume(returning: location)
            locationContinuation = nil
        }
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        locationContinuation?.resume(returning: nil)
        locationContinuation = nil
    }
}
