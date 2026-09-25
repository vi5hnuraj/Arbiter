import Login from "./Login";
import Footer from "../Footer";
import styles from "../../style";
import { layout } from "../../style";

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

const LoginPage = () => {
  const navigate = useNavigate();

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (token) {
      navigate("/overview");
    }
  }, [navigate]);

  return (
    <div className="bg-black w-full overflow-hidden">
    <section className="flex justify-center items-center min-h-[80vh] px-4 py-10">
      <div className="w-full max-w-md">
        <Login />
      </div>
    </section>
    <div className={`bg-primary ${styles.paddingX} ${styles.flexCenter}`}>
      <div className={`${styles.boxWidth}`}>
        <Footer />
      </div>
    </div>
    </div>
  );
};

export default LoginPage;
